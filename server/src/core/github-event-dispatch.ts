import type { Db } from "../db/client.js";
import type { GitBackend } from "./git-backend.js";
import type { Signer } from "./signing.js";
import { syncBranchFromUpstream, type MirrorRow } from "./mirror-inbound.js";
import { ingestWorkflowRun, resolveMirrorReporter, type WorkflowRunPayload } from "./actions-ingest.js";
import { ingestPullRequest, type PullRequestPayload } from "./pull-request-ingest.js";
import { ingestIssue, type IssuePayload } from "./issue-ingest.js";
import { ingestReview, type ReviewPayload } from "./review-ingest.js";
import { resolveGitHubIdentity } from "./github-identity.js";
import type { RecordActor } from "./change-recorder.js";

// One GitHub delivery, turned into ADP's record of it.
//
// Extracted from the per-repository webhook route by #232, for the reason #228
// extracted `syncBranchFromUpstream`: inbound now has three arrivals — a
// per-repository webhook secured by a hand-made secret, a GitHub App's single
// endpoint, and the poller — and they must produce the same record rather than
// three similar ones. What differs between them is authentication and how the
// repository is found. What must not differ is any of this.

export interface DispatchDeps {
  db: Db;
  gitBackend: GitBackend;
  signer: Signer;
  credentialKey: string;
  /** Subject of the DSSE statement written for an ingested upstream run. */
  publicUrl: string;
}

export type GitHubEventPayload = {
  ref?: string;
  after?: string;
  commits?: { id?: string; author?: { username?: string | null } }[];
  head_commit?: { id?: string; author?: { username?: string | null } } | null;
} & WorkflowRunPayload &
  PullRequestPayload &
  IssuePayload &
  ReviewPayload;

// The host an ingested identity belongs to, taken from the mirror's own remote
// URL. A self-hosted instance mirroring GitHub Enterprise gets that hostname,
// and two people with the same login on two hosts stay two identities —
// `external_identities` is `(issuer, subject)`-keyed for exactly this reason.
export function upstreamHostOfMirror(remoteUrl: string): string {
  try {
    return new URL(remoteUrl).host;
  } catch {
    return "github.com";
  }
}

export async function dispatchGitHubEvent(
  deps: DispatchDeps,
  event: string,
  payload: GitHubEventPayload,
  repo: { id: string; owner: string; name: string },
  mirror: MirrorRow,
): Promise<Record<string, unknown>> {
  const { db, gitBackend, signer, credentialKey, publicUrl } = deps;
  const host = upstreamHostOfMirror(mirror.remoteUrl);

  if (event === "workflow_run") {
    const reporterId = await resolveMirrorReporter(db, mirror.identityId);
    if (!reporterId) {
      // Outbound-only mirrors have no system identity, and gate_results
      // .reporterId is a hard FK — nothing safe to attribute this to.
      return { ok: true, skipped: "mirror has no ingest identity" };
    }
    const result = await ingestWorkflowRun(db, signer, publicUrl, repo, reporterId, payload);
    return { ok: true, ...(result.recorded ? { recorded: result.gateName } : { skipped: result.reason }) };
  }

  // A pull request is the object the rest of companion mode hangs off: policy
  // evaluation, undo and the evidence bundle all take a proposal, and until
  // #224 there was none for the work a companion-mode developer actually does.
  // Handled beside workflow_run rather than in the push branch because the two
  // are independent — a pull request exists before any of its commits reach
  // this instance, and its commits reach here whether or not it is ever opened.
  if (event === "pull_request") {
    const actorId = await resolveMirrorReporter(db, mirror.identityId);
    if (!actorId) return { ok: true, skipped: "mirror has no ingest identity" };
    // #230: the pull request's author, not the mirror. `one_approval` is
    // author-independent (#121), so a proposal authored by the system identity
    // that also ingests its approvals is one nothing can ever approve — which
    // is 5-4's whole problem.
    const opener = await resolveGitHubIdentity(db, host, payload.pull_request?.user);
    const result = await ingestPullRequest(db, gitBackend, repo, mirror.id, opener?.identityId ?? actorId, payload);
    return {
      ok: true,
      ...(result.recorded
        ? { recorded: `proposal#${result.number}`, change: result.change }
        : { skipped: result.reason }),
      ...(result.merge ? { merge: result.merge } : {}),
    };
  }

  // #227: a review submitted on GitHub, against the shadow proposal it belongs
  // to. This is what stops 5c's policy check run refusing every mirrored pull
  // request on a requirement GitHub has already met.
  if (event === "pull_request_review") {
    const reviewer = await resolveGitHubIdentity(db, host, payload.review?.user);
    if (!reviewer) {
      // Deliberately not falling back to the mirror's system identity. That
      // identity also authors ingested proposals, and `one_approval` is
      // author-independent (#121) — so the fallback would record an approval
      // that can never count, which is worse than recording none and saying so.
      return { ok: true, skipped: "review names no upstream user" };
    }
    const result = await ingestReview(db, repo, reviewer.identityId, payload);
    return { ok: true, ...(result.recorded ? { recorded: `review:${result.state}` } : { skipped: result.reason }) };
  }

  // #226: the other half of "what was this for". An issue becomes an intent
  // carrying which issue it is and on whose host, plus the issue row that makes
  // `ADP-Intent: #92` in a commit message resolve to it.
  if (event === "issues") {
    const actorId = await resolveMirrorReporter(db, mirror.identityId);
    if (!actorId) return { ok: true, skipped: "mirror has no ingest identity" };
    const filer = await resolveGitHubIdentity(db, host, payload.issue?.user);
    const result = await ingestIssue(db, repo, filer?.identityId ?? actorId, payload);
    return {
      ok: true,
      ...(result.recorded
        ? { recorded: `issue#${result.number}`, change: result.change, intent_id: result.intentId }
        : { skipped: result.reason }),
    };
  }

  if (event !== "push") return { ok: true, skipped: `unhandled event '${event}'` };
  if (!payload.ref || !payload.after) return { ok: true, skipped: "not a branch push event" };

  const remoteRef = payload.ref; // e.g. refs/heads/main
  const branch = remoteRef.replace(/^refs\/heads\//, "");
  // Not a branch ref (e.g. a tag) — v0 only mirrors branches.
  if (remoteRef === branch) return { ok: true, skipped: "not a branch ref" };

  // #228: the same function the inbound poller calls. Three arrivals, one
  // record — see core/mirror-inbound.ts for why that is a requirement rather
  // than a convenience.
  const result = await syncBranchFromUpstream(
    db,
    gitBackend,
    signer,
    credentialKey,
    mirror,
    repo,
    branch,
    await commitAuthors(db, host, payload),
  );
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

// Who wrote each commit in a push, as far as the payload says.
//
// GitHub names a commit's author by `username` and nothing else here — no
// numeric id, which is why core/github-identity.ts keys a login-only sighting
// separately and upgrades it later. The array is capped at 20 by GitHub, and a
// first import walks history nothing was ever delivered for, so this map is
// deliberately partial: `recordPushedCommits` falls back to the mirror identity
// for a commit it does not cover, which stays the honest answer for one whose
// author this instance has no way to know.
async function commitAuthors(
  db: Db,
  host: string,
  payload: GitHubEventPayload,
): Promise<Map<string, RecordActor>> {
  const out = new Map<string, RecordActor>();
  const entries = [...(payload.commits ?? []), ...(payload.head_commit ? [payload.head_commit] : [])];

  // One resolution per distinct login rather than one per commit: a 20-commit
  // push from one person is one lookup, and this runs inline on the delivery.
  const byLogin = new Map<string, RecordActor | null>();
  for (const commit of entries) {
    const login = commit?.author?.username?.trim();
    if (!commit?.id || !login) continue;
    if (!byLogin.has(login)) {
      const resolved = await resolveGitHubIdentity(db, host, { login });
      byLogin.set(
        login,
        resolved ? { id: resolved.identityId, kind: resolved.kind, principal: resolved.principal } : null,
      );
    }
    const actor = byLogin.get(login);
    if (actor) out.set(commit.id, actor);
  }
  return out;
}
