import { and, eq, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "./git-backend.js";
import type { Signer } from "./signing.js";
import { mirrors, repos } from "../db/schema.js";
import { decryptCredential } from "./mirror-crypto.js";
import { parseGitHubRemote } from "../http-rest/actions.js";
import { syncBranchFromUpstream, type MirrorRow } from "./mirror-inbound.js";
import { ingestPullRequest } from "./pull-request-ingest.js";
import { ingestIssue } from "./issue-ingest.js";
import { ingestReview } from "./review-ingest.js";
import { ingestWorkflowRun, resolveMirrorReporter } from "./actions-ingest.js";
import { resolveGitHubIdentity } from "./github-identity.js";
import type { RecordActor } from "./change-recorder.js";

// Inbound mirroring for an instance nothing can reach.
//
// `adp init` configures the mirror and then prints a webhook URL and a secret
// for a human to paste into GitHub's settings. Until that is done by hand,
// inbound ingests nothing: the mode is configured, reports success, and records
// only what an outbound push already knew. A developer without a publicly
// reachable hostname cannot do it at all — which is most people evaluating this
// on the machine they already have.
//
// So this is not a degraded substitute for the webhook. It is the version of
// companion mode that runs on a laptop, and the design constraint that follows
// is that it must produce the *same record*, not a similar one. Every fact it
// ingests goes through the same function the webhook calls —
// `syncBranchFromUpstream`, `ingestPullRequest`, `ingestIssue`, `ingestReview`,
// `ingestWorkflowRun` — all of which were already idempotent because GitHub
// redelivers. That is what makes running both at once safe rather than merely
// unlikely to collide.

const PER_PAGE = 100;
// How far back a first poll looks for closed work. Open pull requests and
// issues are fetched regardless of age; this bounds only the backfill of things
// that have already finished, where the useful window is "recent enough to
// still be talked about" rather than "all of history".
const FIRST_POLL_BACKFILL_DAYS = 30;

export interface InboundPollDeps {
  db: Db;
  gitBackend: GitBackend;
  signer: Signer;
  credentialKey: string;
  /** Subject of the DSSE statement for an ingested run, as elsewhere. */
  publicUrl: string;
  /** Injectable so tests stand up a fake upstream rather than reaching api.github.com. */
  fetchImpl?: typeof fetch;
}

export interface MirrorPollSummary {
  repo: string;
  branches: number;
  pullRequests: number;
  issues: number;
  reviews: number;
  runs: number;
  errors: string[];
}

interface GhUser {
  id?: number | null;
  login?: string | null;
  type?: string | null;
}

interface GhPull {
  number: number;
  title?: string;
  body?: string | null;
  state?: string;
  merged_at?: string | null;
  closed_at?: string | null;
  updated_at?: string;
  html_url?: string;
  draft?: boolean;
  merge_commit_sha?: string | null;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
  user?: GhUser;
}

/**
 * One inbound poll across every mirror configured to receive.
 *
 * Errors are collected per mirror rather than thrown: one repository whose PAT
 * has expired must not stop every other repository from syncing, and a poller
 * that dies on the first failure is one that silently stops being a poller.
 */
export async function pollInboundOnce(deps: InboundPollDeps): Promise<MirrorPollSummary[]> {
  const { db } = deps;
  const rows = await db
    .select({ mirror: mirrors, repo: repos })
    .from(mirrors)
    .innerJoin(repos, eq(mirrors.repoId, repos.id))
    .where(
      and(
        eq(mirrors.enabled, true),
        or(eq(mirrors.direction, "inbound"), eq(mirrors.direction, "both")),
      ),
    );

  const summaries: MirrorPollSummary[] = [];
  for (const row of rows) {
    summaries.push(await pollMirror(deps, row.mirror, row.repo));
  }
  return summaries;
}

export async function pollMirror(
  deps: InboundPollDeps,
  mirror: MirrorRow,
  repo: { id: string; owner: string; name: string },
): Promise<MirrorPollSummary> {
  const { db, gitBackend, signer, credentialKey, publicUrl } = deps;
  const summary: MirrorPollSummary = {
    repo: `${repo.owner}/${repo.name}`,
    branches: 0,
    pullRequests: 0,
    issues: 0,
    reviews: 0,
    runs: 0,
    errors: [],
  };

  const upstream = parseGitHubRemote(mirror.remoteUrl);
  if (!upstream) {
    summary.errors.push(`remote '${mirror.remoteUrl}' is not a recognisable GitHub repository URL`);
    return summary;
  }

  const host = hostOf(mirror.remoteUrl);
  const token = decryptCredential(mirror.credentialCiphertext, credentialKey);
  const fetchImpl = deps.fetchImpl ?? fetch;
  // The cursor is read before any work and written after all of it, and it is
  // the time the poll *started*. Writing "now" at the end would open a window
  // the width of the poll itself, in which an update that landed while the poll
  // was running is newer than the cursor and is never looked at again.
  const startedAt = new Date();
  const since = mirror.lastPolledAt ?? new Date(startedAt.getTime() - FIRST_POLL_BACKFILL_DAYS * 86_400_000);

  const api = async <T>(path: string): Promise<T> => {
    const res = await fetchImpl(`https://api.github.com/repos/${upstream.owner}/${upstream.repo}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${token}`,
        "User-Agent": "adp-mirror-poller",
      },
    });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return (await res.json()) as T;
  };

  const actorId = await resolveMirrorReporter(db, mirror.identityId);

  // --- branches -----------------------------------------------------------
  //
  // Fetched per branch rather than as one `+refs/heads/*` refspec so that a
  // single diverged branch is reported as diverged and the rest still sync —
  // which is the same reason the webhook path handles one ref per delivery.
  try {
    const branches = await api<{ name: string; commit: { sha: string } }[]>(`/branches?per_page=${PER_PAGE}`);
    for (const branch of branches) {
      const local = await gitBackend.resolveRef(repo.owner, repo.name, branch.name);
      if (local === branch.commit.sha) continue;

      const result = await syncBranchFromUpstream(
        db,
        gitBackend,
        signer,
        credentialKey,
        mirror,
        repo,
        branch.name,
        await commitAuthors(db, host, api, branch.name, since),
      );
      if (result.ok && result.outcome === "moved") summary.branches += 1;
      else if (!result.ok) summary.errors.push(`branch ${branch.name}: ${result.reason}`);
    }
  } catch (err) {
    summary.errors.push(`branches: ${message(err)}`);
  }

  // --- pull requests, and the reviews on them -----------------------------
  const changedPulls: GhPull[] = [];
  try {
    // `sort=updated&direction=desc` and stop at the cursor, because GitHub's
    // pulls endpoint has no `since`. `state=all` so a pull request that closed
    // since the last poll is seen closing — with `state=open` a merge would be
    // invisible, which is the one transition companion mode most needs.
    const pulls = await api<GhPull[]>(`/pulls?state=all&sort=updated&direction=desc&per_page=${PER_PAGE}`);
    for (const pull of pulls) {
      if (pull.updated_at && new Date(pull.updated_at) <= since) break;
      changedPulls.push(pull);
    }

    for (const pull of changedPulls) {
      const opener = await resolveGitHubIdentity(db, host, pull.user);
      // `proposals.authorId` is a hard foreign key, and an outbound-only mirror
      // has no system identity to fall back to. Nothing safe to attribute this
      // to means nothing is written — the same call the webhook makes.
      const author = opener?.identityId ?? actorId;
      if (!author) continue;
      const result = await ingestPullRequest(
        db,
        gitBackend,
        repo,
        mirror.id,
        author,
        { action: "poll", pull_request: { ...pull, merged: !!pull.merged_at } },
      );
      if (result.recorded) summary.pullRequests += 1;
    }
  } catch (err) {
    summary.errors.push(`pulls: ${message(err)}`);
  }

  for (const pull of changedPulls) {
    try {
      const reviews = await api<
        { id: number; state?: string; body?: string | null; submitted_at?: string | null; user?: GhUser }[]
      >(`/pulls/${pull.number}/reviews?per_page=${PER_PAGE}`);
      for (const review of reviews) {
        const reviewer = await resolveGitHubIdentity(db, host, review.user);
        // Same refusal the webhook makes, and for the same reason: falling back
        // to the mirror's system identity would record an approval that can
        // never count, because that identity also authors ingested proposals.
        if (!reviewer) continue;
        const result = await ingestReview(db, repo, reviewer.identityId, {
          action: "poll",
          review,
          pull_request: { number: pull.number },
        });
        if (result.recorded) summary.reviews += 1;
      }
    } catch (err) {
      summary.errors.push(`reviews for #${pull.number}: ${message(err)}`);
    }
  }

  // --- issues -------------------------------------------------------------
  try {
    // GitHub's issues endpoint returns pull requests too; `ingestIssue` skips
    // anything carrying a `pull_request` key, so the filtering lives in one
    // place rather than being repeated by every caller.
    const issues = await api<
      {
        number: number;
        title?: string;
        body?: string | null;
        state?: string;
        html_url?: string;
        closed_at?: string | null;
        pull_request?: unknown;
        user?: GhUser;
      }[]
    >(`/issues?state=all&since=${encodeURIComponent(since.toISOString())}&per_page=${PER_PAGE}`);

    for (const issue of issues) {
      const filer = await resolveGitHubIdentity(db, host, issue.user);
      const author = filer?.identityId ?? actorId;
      if (!author) continue;
      const result = await ingestIssue(db, repo, author, {
        action: "poll",
        issue,
        repository: { html_url: mirror.remoteUrl },
      });
      if (result.recorded) summary.issues += 1;
    }
  } catch (err) {
    summary.errors.push(`issues: ${message(err)}`);
  }

  // --- workflow runs ------------------------------------------------------
  if (actorId) {
    try {
      const { workflow_runs } = await api<{ workflow_runs: Record<string, unknown>[] }>(
        `/actions/runs?status=completed&per_page=${PER_PAGE}`,
      );
      for (const run of workflow_runs ?? []) {
        const updated = run.updated_at as string | undefined;
        if (updated && new Date(updated) <= since) continue;
        const result = await ingestWorkflowRun(db, signer, publicUrl, repo, actorId, {
          action: "completed",
          workflow_run: run,
        });
        if (result.recorded) summary.runs += 1;
      }
    } catch (err) {
      summary.errors.push(`runs: ${message(err)}`);
    }
  }

  // Advanced only when something was actually asked of upstream. A poll that
  // failed outright must not move the cursor past the window it never read.
  if (summary.errors.length === 0) {
    await db.update(mirrors).set({ lastPolledAt: startedAt, updatedAt: new Date() }).where(eq(mirrors.id, mirror.id));
  }
  return summary;
}

// Who wrote each commit on a branch, from the commits API.
//
// Strictly better than the webhook's source: a push payload names a commit's
// author by login alone, and this carries the numeric user id — which is the
// key core/github-identity.ts prefers, and why a login-keyed identity created
// by a webhook gets upgraded the first time a poll sees the same person.
async function commitAuthors(
  db: Db,
  host: string,
  api: <T>(path: string) => Promise<T>,
  branch: string,
  since: Date,
): Promise<Map<string, RecordActor>> {
  const out = new Map<string, RecordActor>();
  try {
    const commits = await api<{ sha: string; author?: GhUser | null }[]>(
      `/commits?sha=${encodeURIComponent(branch)}&since=${encodeURIComponent(since.toISOString())}&per_page=${PER_PAGE}`,
    );
    const byLogin = new Map<string, RecordActor | null>();
    for (const commit of commits) {
      const login = commit.author?.login;
      if (!commit.sha || !login) continue;
      if (!byLogin.has(login)) {
        const resolved = await resolveGitHubIdentity(db, host, commit.author);
        byLogin.set(
          login,
          resolved ? { id: resolved.identityId, kind: resolved.kind, principal: resolved.principal } : null,
        );
      }
      const actor = byLogin.get(login);
      if (actor) out.set(commit.sha, actor);
    }
  } catch {
    // Attribution is an improvement on the record, not a precondition for it.
    // A commits call that fails leaves the map empty and every commit falls
    // back to the mirror identity — the same place the webhook path lands for
    // a commit its payload did not name.
  }
  return out;
}

function hostOf(remoteUrl: string): string {
  try {
    return new URL(remoteUrl).host;
  } catch {
    return "github.com";
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function startInboundPoller(deps: InboundPollDeps, intervalMs: number): NodeJS.Timeout {
  return setInterval(() => {
    pollInboundOnce(deps).catch((err) => {
      console.error("mirror inbound poller tick failed:", err);
    });
  }, intervalMs);
}
