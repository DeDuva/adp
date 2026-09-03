import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { proposals } from "../db/schema.js";
import { parseGitHubRemote } from "../http-rest/actions.js";
import { findGitHubApp, findInstallation, installationToken } from "./github-app.js";
import { getEvidenceBundle } from "./evidence.js";
import { evaluateLandPolicy, renderUnmet } from "./land-policy.js";
import { findOrgLandContext } from "./org-lookup.js";
import { repos } from "../db/schema.js";
import type { LandRequirement } from "./repo-policy.js";
import type { GitBackend } from "./git-backend.js";
import type { MirrorRow } from "./mirror-inbound.js";

// What ADP knows about a pull request, published where the work already is.
//
// Everything this phase built is invisible to a developer who never leaves
// GitHub: the intent the change is bound to, the trajectory that produced it,
// the signed evidence behind the verdict. A check run is where GitHub already
// looks, and publishing there is the whole additive claim made visible.
//
// It requires the App (#232) and cannot be done without it: GitHub's Checks API
// refuses personal access tokens outright, whatever scopes they carry. An
// instance still on the PAT path publishes nothing and says so rather than
// failing — the record is complete either way, and a check run is a view of it.

export interface CheckRunDeps {
  db: Db;
  credentialKey: string;
  publicUrl: string;
  fetchImpl?: typeof fetch;
}

export interface CheckRunOutcome {
  published: boolean;
  reason?: string;
  name?: string;
  conclusion?: string;
}

export interface CheckRunSpec {
  name: string;
  headSha: string;
  conclusion: "success" | "neutral" | "failure";
  title: string;
  summary: string;
  detailsUrl: string | null;
}

/**
 * The upstream context a check run needs: which repository on GitHub, and which
 * installation is allowed to write to it.
 *
 * Returns null for every reason a check run cannot be published, because none
 * of them is an error: an instance on the PAT path has no App, a repository
 * whose owner never installed it has no installation, and a mirror pointing
 * somewhere that is not GitHub has neither.
 */
export async function upstreamCheckContext(
  deps: CheckRunDeps,
  mirror: MirrorRow,
): Promise<{ owner: string; repo: string; token: string } | { reason: string }> {
  const upstream = parseGitHubRemote(mirror.remoteUrl);
  if (!upstream) return { reason: "mirror remote is not a GitHub repository" };

  const app = await findGitHubApp(deps.db);
  if (!app) return { reason: "no GitHub App — check runs need one, a personal access token cannot create them" };

  const installation = await findInstallation(deps.db, app.id, upstream.owner);
  if (!installation) return { reason: `the ADP App is not installed on ${upstream.owner}` };

  const token = await installationToken(
    deps.db,
    deps.credentialKey,
    installation.installationId,
    deps.fetchImpl ?? fetch,
  );
  return { owner: upstream.owner, repo: upstream.repo, token };
}

/**
 * Create the check run, or update the one already there for this name and sha.
 *
 * Update rather than append, because GitHub keeps every check run with the same
 * name on a commit and shows the newest — so appending works and leaves a pile
 * of stale rows a reader has to scroll past to reach the one that is true. A
 * check run is a *current* statement about a commit, and there is one of it.
 */
export async function publishCheckRun(
  deps: CheckRunDeps,
  upstream: { owner: string; repo: string; token: string },
  spec: CheckRunSpec,
): Promise<CheckRunOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${upstream.token}`,
    "User-Agent": "adp-check-runs",
    "Content-Type": "application/json",
  };
  const base = `https://api.github.com/repos/${upstream.owner}/${upstream.repo}`;

  const body = {
    name: spec.name,
    head_sha: spec.headSha,
    status: "completed",
    conclusion: spec.conclusion,
    completed_at: new Date().toISOString(),
    ...(spec.detailsUrl ? { details_url: spec.detailsUrl } : {}),
    output: { title: spec.title, summary: spec.summary },
  };

  try {
    const existing = await fetchImpl(
      `${base}/commits/${encodeURIComponent(spec.headSha)}/check-runs?check_name=${encodeURIComponent(spec.name)}`,
      { headers },
    );
    let id: number | null = null;
    if (existing.ok) {
      const listed = (await existing.json()) as { check_runs?: { id: number }[] };
      id = listed.check_runs?.[0]?.id ?? null;
    }

    const res = id
      ? await fetchImpl(`${base}/check-runs/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) })
      : await fetchImpl(`${base}/check-runs`, { method: "POST", headers, body: JSON.stringify(body) });

    if (!res.ok) return { published: false, reason: `GitHub refused the check run (${res.status})`, name: spec.name };
    return { published: true, name: spec.name, conclusion: spec.conclusion };
  } catch (err) {
    // Never throws to the caller. This runs inside a webhook delivery, and a
    // failed check-run write must not turn a successful ingest into a delivery
    // GitHub retries — the record is already correct, and only its view of
    // itself is missing.
    return {
      published: false,
      reason: err instanceof Error ? err.message : String(err),
      name: spec.name,
    };
  }
}

export const CHANGE_RECORD_CHECK = "ADP / change record";

/**
 * `ADP / change record` — intent, producer, trajectory and evidence, on the
 * pull request.
 *
 * Never a verdict. `success` says a signed change record exists for this
 * commit and `neutral` says none does yet, and both pass if somebody makes it
 * required — the check that is allowed to block is 5-11's, and this one exists
 * to be read.
 */
export async function publishChangeRecordCheck(
  deps: CheckRunDeps,
  repo: { id: string; owner: string; name: string },
  mirror: MirrorRow,
  proposalNumber: number,
): Promise<CheckRunOutcome> {
  const [proposal] = await deps.db
    .select()
    .from(proposals)
    .where(and(eq(proposals.repoId, repo.id), eq(proposals.number, proposalNumber)));
  if (!proposal) return { published: false, reason: `no proposal #${proposalNumber}` };

  const upstream = await upstreamCheckContext(deps, mirror);
  if ("reason" in upstream) return { published: false, reason: upstream.reason };

  const bundle = await getEvidenceBundle(deps.db, repo.id, proposal.headSha);
  const detailsUrl = `${deps.publicUrl.replace(/\/$/, "")}/api/adp/repos/${repo.owner}/${repo.name}/evidence/${proposal.headSha}`;

  return publishCheckRun(deps, upstream, {
    name: CHANGE_RECORD_CHECK,
    headSha: proposal.headSha,
    conclusion: bundle.change ? "success" : "neutral",
    title: bundle.change ? "Signed change record" : "No change record yet",
    summary: renderChangeRecord(bundle, detailsUrl),
    detailsUrl,
  });
}

/**
 * The summary, in Markdown, because that is what GitHub renders.
 *
 * Written to be read by a person who has never used ADP and is looking at a
 * pull request. Every line is a fact the record already holds — nothing here is
 * computed for display, and nothing is omitted because it looks bad: a change
 * bound to no intent says so, which is the state the whole product is about
 * noticing.
 */
function renderChangeRecord(
  bundle: Awaited<ReturnType<typeof getEvidenceBundle>>,
  detailsUrl: string,
): string {
  if (!bundle.change) {
    return (
      "No signed change record exists for this commit yet.\n\n" +
      "That is ordinary while the push is still being ingested, and it is not a failure — " +
      "this check reports what ADP knows and never blocks a merge."
    );
  }

  const lines: string[] = [];
  const intent = bundle.change.intent;
  lines.push(
    intent
      ? `**Intent** — ${intent.upstream_url ? `[${intent.title}](${intent.upstream_url})` : intent.title}`
      : "**Intent** — none. This commit carries no `ADP-Intent` trailer and was never bound afterwards.",
  );

  const provenance = (bundle.change.provenance ?? {}) as Record<string, unknown>;
  lines.push(`**Author** — \`${String(provenance.principal ?? "unknown")}\` (arrived \`${String(provenance.via ?? "?")}\`)`);

  const models = bundle.produced_by.models;
  if (models.source === "observed") {
    lines.push(`**Model** — ${models.observed.join(" → ")}, observed in the trajectory`);
  } else if (models.source === "asserted") {
    lines.push(`**Model** — ${models.asserted}, asserted by the harness rather than observed`);
  }

  for (const session of bundle.produced_by.sessions) {
    lines.push(`**Session** — \`${session.id}\` on ${session.harness}`);
  }

  const green = bundle.gates.filter((g) => g.status === "success").length;
  if (bundle.gates.length > 0) {
    lines.push(`**Gates** — ${green}/${bundle.gates.length} green, each carrying a signed DSSE envelope`);
  }

  lines.push("");
  lines.push(`The record is signed. [Full evidence bundle](${detailsUrl})`);
  return lines.join("\n\n");
}

export const POLICY_CHECK = "ADP / policy";

/**
 * `ADP / policy` — the land policy's verdict, published where branch protection
 * can require it.
 *
 * **This is a check, not a merge gate of our own, and that is the resolution of
 * the seam this whole phase opens on.** Asking a developer to choose between
 * GitHub's merge plane and ADP's is the choice mirror mode exists to avoid;
 * publishing a verdict GitHub already knows how to require is the same
 * enforcement with none of the migration. GitHub stays the merge authority and
 * will not merge until ADP agrees, because the repository owner made this
 * required — not because ADP took the button away.
 *
 * It only became honest once #227 landed. Before ingest carried approvals, this
 * would have refused every mirrored pull request on `one_approval` — a
 * requirement GitHub had already met — which is worse than publishing nothing,
 * because a developer who has done what the policy asks and is told they have
 * not stops believing the policy.
 */
export async function publishPolicyCheck(
  deps: CheckRunDeps & { gitBackend: GitBackend; instanceFloor: LandRequirement[] },
  repo: { id: string; owner: string; name: string },
  mirror: MirrorRow,
  proposalNumber: number,
): Promise<CheckRunOutcome> {
  const [proposal] = await deps.db
    .select()
    .from(proposals)
    .where(and(eq(proposals.repoId, repo.id), eq(proposals.number, proposalNumber)));
  if (!proposal) return { published: false, reason: `no proposal #${proposalNumber}` };

  const upstream = await upstreamCheckContext(deps, mirror);
  if ("reason" in upstream) return { published: false, reason: upstream.reason };

  const [repoRow] = await deps.db.select({ orgId: repos.orgId }).from(repos).where(eq(repos.id, repo.id));
  const org = await findOrgLandContext(deps.db, repoRow?.orgId ?? null);
  const verdict = await evaluateLandPolicy(
    deps.db,
    deps.gitBackend,
    deps.instanceFloor,
    repo,
    proposal,
    org,
  );

  return publishCheckRun(deps, upstream, {
    name: POLICY_CHECK,
    headSha: proposal.headSha,
    conclusion: verdict.allowed ? "success" : "failure",
    title: verdict.allowed ? "Land policy satisfied" : `${verdict.unmet.length} requirement(s) unmet`,
    summary: renderPolicy(verdict),
    detailsUrl: `${deps.publicUrl.replace(/\/$/, "")}/api/adp/repos/${repo.owner}/${repo.name}/evidence/${proposal.headSha}`,
  });
}

/**
 * The verdict, in Markdown.
 *
 * Each unmet requirement keeps the remedy and the literal command #145 gave it.
 * A refusal that explains itself is the moment a first-time user sees the thesis
 * work, and a check run is the surface where most of them will meet it for the
 * first time — so dropping the remedy here to keep the summary short would undo
 * exactly what #145 bought.
 */
function renderPolicy(verdict: Awaited<ReturnType<typeof evaluateLandPolicy>>): string {
  const lines: string[] = [];
  if (verdict.allowed) {
    lines.push("Every requirement this repository's `adp.yaml` declares is satisfied.");
  } else {
    lines.push("This change does not yet satisfy the land policy:");
    lines.push("");
    for (const unmet of verdict.unmet) lines.push(`- ${renderUnmet(unmet)}`);
  }

  // Advisories are reported whether or not the verdict allowed the land. A
  // quarantined gate that silently stops mattering is worse than a flaky gate,
  // which is the reason the quarantine is an advisory rather than a silence.
  if (verdict.advisories.length > 0) {
    lines.push("");
    lines.push("**Advisories**");
    lines.push("");
    for (const advisory of verdict.advisories) lines.push(`- ${advisory}`);
  }

  lines.push("");
  lines.push(
    "ADP does not merge this pull request — GitHub does. Requiring this check in branch protection " +
      "is what makes the verdict binding.",
  );
  return lines.join("\n");
}
