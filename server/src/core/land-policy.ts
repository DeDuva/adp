import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "./git-backend.js";
import { reviews } from "../db/schema.js";
import { loadRepoPolicy, resolveLandRequirements, type LandRequirement, type StatisticalPolicy } from "./repo-policy.js";
import { loadOrgPolicy } from "./org-policy.js";
import { latestGateResults, allGatesGreen } from "./gate-results-lookup.js";
import { gateFlakeStats, wilsonLowerBound, type FlakeStats } from "./flake-stats.js";

// M4-2: what a repo's org contributes to land policy. `null` when the repo
// has no org (every pre-M4 repo). `policyRepo` is `null` when the org
// exists but has designated no policy repo — an empty floor, not an error.
export interface OrgLandContext {
  killSwitch: boolean;
  policyRepo: { owner: string; name: string; defaultBranch: string } | null;
}

export interface QuarantinedGate {
  name: string;
  flakeRate: number;
  flips: number;
  distinctShas: number;
  /** What the gate's latest verdict actually was, before quarantine set it aside. */
  latestStatus: string;
}

// #145: a refusal is the moment a first-time user sees the thesis work —
// `make demo` is built around reaching it, and the manual test plan calls it
// out deliberately: "a policy that has never been seen to refuse anything has
// not been tested." Until this, that moment produced a typed 422 listing the
// unmet requirements and stopped one step short: told `one_approval` was
// unmet, the user went back to the documentation at exactly the moment the
// product was about to prove itself.
//
// So an unmet requirement is a structured thing rather than a sentence: what
// is missing, what to do about it, and — where one exists — the literal
// command that satisfies it. The same instinct the repo already has for
// unimplemented REST endpoints, which 404 *naming the ADP equivalent* on the
// reasoning that "a broken call that explains itself costs an agent one turn;
// a hang or a 500 costs it the trajectory". A refusal that explains itself is
// that argument applied to the happy path.
export interface UnmetRequirement {
  /** The policy requirement that is not satisfied — `gates_green`, `one_approval`, … */
  requirement: string;
  /** What is missing, in one clause. */
  problem: string;
  /** What to do about it, as a sentence. */
  remedy: string;
  /**
   * The literal command that satisfies it, where one exists. Absent — not
   * invented — where nothing a user can type fixes it: a gate that ran and
   * failed is satisfied by a new commit, not by a command, and saying
   * otherwise would teach the wrong thing about what the gate is for.
   */
  command?: string;
}

// One place a refusal becomes a line, because it has to read the same on
// three surfaces: the REST body, a GraphQL error (which is what `gh pr merge`
// prints, and where most users will actually read it), and anything that
// wraps either.
export function renderUnmet(u: UnmetRequirement): string {
  return `${u.requirement}: ${u.problem} → ${u.remedy}${u.command ? `: ${u.command}` : ""}`;
}

// The refusal body both merge paths send. `unmet` keeps its shape — an array
// of strings, which is what every existing client reads — and each string now
// carries its own remedy, because error prose is explicitly not contract
// (docs/api-compatibility.md) and a caller that only prints the line still
// gets the whole answer. `unmet_detail` is the same facts with the seams left
// in, for a caller that wants the command without parsing a sentence.
export function landRefusalBody(message: string, unmet: UnmetRequirement[]) {
  return { message, unmet: unmet.map(renderUnmet), unmet_detail: unmet };
}

export interface LandPolicyResult {
  allowed: boolean;
  unmet: UnmetRequirement[];
  /**
   * Things that did not block the land but that a caller must be able to see.
   * A quarantined gate is the case this exists for: a gate that silently stops
   * mattering is worse than a flaky gate.
   */
  advisories: string[];
  quarantined: QuarantinedGate[];
}

// The M1c land-policy gate: instance floor ∧ repo adp.yaml.
// Repo policy is read off the *base*
// ref — the branch being landed into, same as GitHub reads branch
// protection off the target branch, not the PR's head.
//
// M3 adds two statistical criteria on top (the A8 contribution):
//
//   quarantine       — a gate that disagrees with itself often enough stops
//                      blocking land, but never silently: it is reported as an
//                      advisory here and recorded as a `gate.quarantine`
//                      operation by the land path when it actually takes effect.
//   gates_confident  — a gate is green *and* the Wilson lower bound on its
//                      trailing pass rate clears `min_pass_rate`. Below
//                      `min_runs` observations it falls back to gates_green and
//                      says so, rather than failing closed on thin data.
export async function evaluateLandPolicy(
  db: Db,
  gitBackend: GitBackend,
  instanceFloor: LandRequirement[],
  repo: { id: string; owner: string; name: string },
  proposal: { id: string; number: number; baseRef: string; headSha: string; authorId: string },
  org: OrgLandContext | null = null,
): Promise<LandPolicyResult> {
  // Checked first and unconditionally: a killed org refuses every land for
  // every repo in it, before any gate, review, or statistic is even loaded.
  if (org?.killSwitch) {
    return {
      allowed: false,
      unmet: [
        {
          requirement: "org_kill_switch",
          problem: "the org kill switch is active, so every land in this org is refused",
          remedy:
            "this is not a per-proposal state and nothing on the proposal will clear it — " +
            "an org admin lifts it",
          command: `curl -X PATCH "$ADP_URL/api/adp/orgs/<org-id>" -H "Authorization: Bearer $ADP_TOKEN" ` +
            `-H 'Content-Type: application/json' -d '{"kill_switch":false}'`,
        },
      ],
      advisories: [],
      quarantined: [],
    };
  }

  const repoPolicy = await loadRepoPolicy(gitBackend, repo.owner, repo.name, proposal.baseRef);
  const orgPolicy = await loadOrgPolicy(gitBackend, org?.policyRepo ?? null);
  const required = resolveLandRequirements(instanceFloor, orgPolicy.land.require, repoPolicy);
  const statistical = repoPolicy.land.statistical;
  const unmet: UnmetRequirement[] = [];

  // The command that reports a gate result by hand. Named per gate because
  // that is the grain the remedy has to be actionable at: "some gate is not
  // green" is the sentence the user already had.
  const reportGate = (gate: string) =>
    `adp gate report --repo ${repo.owner}/${repo.name} --sha ${proposal.headSha} --name ${gate} --status success`;
  const shortSha = proposal.headSha.slice(0, 7);

  // A gate blocks land in one of two ways, and they are fixed by different
  // things — which is exactly the distinction the old single sentence ("X not
  // green") collapsed. A gate nobody has reported is waiting on a runner; a
  // gate that ran and said failure is waiting on a different commit.
  const gateUnmet = (requirement: string, gate: string): UnmetRequirement => {
    const status = latest.get(gate)?.status;
    if (!status) {
      return {
        requirement,
        problem: `${gate} not reported for ${shortSha}`,
        remedy: "gates run on push — check a runner is up (`adp runner`), or report one",
        command: reportGate(gate),
      };
    }
    return {
      requirement,
      problem: `${gate} reported ${status} for ${shortSha}`,
      // Deliberately no command. Nothing typed at a terminal makes a red gate
      // green, and offering `adp gate report --status success` here would
      // teach a first-time user that the gate is a formality.
      remedy: "fix the change and push again — the new commit gets its own gate run",
    };
  };

  const advisories: string[] = [];
  const quarantined: QuarantinedGate[] = [];

  const needsGates = required.includes("gates_green") || required.includes("gates_confident");
  const latest = needsGates
    ? await latestGateResults(db, repo.id, proposal.headSha)
    : new Map<string, { status: string }>();

  // Statistics are per gate name and independent of the commit, so they are
  // computed once here and reused by both requirements below.
  const stats = new Map<string, FlakeStats>();
  if (needsGates && statistical.enabled) {
    for (const name of repoPolicy.gates) {
      stats.set(name, await gateFlakeStats(db, repo.id, name, statistical.window));
    }
  }

  for (const name of repoPolicy.gates) {
    const s = stats.get(name);
    if (!s || s.distinctShas === 0) continue;
    if (s.flakeRate > statistical.quarantine_threshold) {
      quarantined.push({
        name,
        flakeRate: s.flakeRate,
        flips: s.flips,
        distinctShas: s.distinctShas,
        latestStatus: latest.get(name)?.status ?? "none",
      });
      advisories.push(
        `quarantine: ${name} is flaky (${s.flips}/${s.distinctShas} commits disagreed with themselves, ` +
          `flake rate ${s.flakeRate.toFixed(2)} > ${statistical.quarantine_threshold}) — it no longer blocks land`,
      );
    }
  }
  const quarantinedNames = new Set(quarantined.map((q) => q.name));

  if (required.includes("gates_green")) {
    // A quarantined gate is excluded from the green check rather than forced
    // green: the distinction matters because the advisory above still reports
    // its real verdict, so nothing is hidden, only set aside.
    const gated = repoPolicy.gates.filter((name) => !quarantinedNames.has(name));
    if (!allGatesGreen(gated, latest)) {
      const failing = gated.filter((name) => latest.get(name)?.status !== "success");
      if (failing.length === 0) {
        // The repo declares no gates at all, so `gates_green` can never be
        // satisfied by reporting one of them — there is nothing to report
        // against. This is the shape a fresh instance hits.
        unmet.push({
          requirement: "gates_green",
          problem: `no gate results reported for ${shortSha}`,
          remedy:
            "gates run on push once `runner.gates` is declared in adp.yaml on " +
            `'${proposal.baseRef}' and a runner is up; until then, report one by hand`,
          command: reportGate("test"),
        });
      }
      // One entry per gate rather than one naming them all: the remedy is only
      // useful at the grain the command is written at.
      for (const gate of failing) unmet.push(gateUnmet("gates_green", gate));
    }
  }

  if (required.includes("gates_confident")) {
    unmet.push(...confidenceFailures(repoPolicy.gates, quarantinedNames, latest, stats, statistical, gateUnmet, proposal.baseRef));

    for (const name of repoPolicy.gates) {
      if (quarantinedNames.has(name)) continue;
      const s = stats.get(name);
      if (statistical.enabled && s && s.runs > 0 && s.runs < statistical.min_runs) {
        advisories.push(
          `gates_confident: ${name} has only ${s.runs} observed run(s) (min_runs ${statistical.min_runs}) — ` +
            "falling back to gates_green for this gate",
        );
      }
    }
  }

  if (required.includes("one_approval")) {
    // Author-independent by construction (#121): an approval from the
    // principal that authored the proposal is not an approval. Before this,
    // `one_approval` counted any approved row, and the M3 arm-2 bench agent
    // duly satisfied it with `gh pr review --approve` on its own PR in the
    // same trajectory — the policy met without a second judgment anywhere.
    // GitHub refuses self-approval outright; the requirement that exists to
    // bind self-attestation must not be weaker than the incumbent.
    //
    // The comparison is on the principal, not on the review row: a proposal
    // with three approvals all from its author is as unapproved as one with
    // none, and says so differently, because the two are fixed by different
    // actions.
    // #227: the reviewer's *current* opinion, not every opinion they have ever
    // held. GitHub counts the most recent non-comment review per reviewer, and
    // until ingest existed the difference could not arise here — a native
    // reviewer who approved and then requested changes left both rows, and the
    // approval went on satisfying the requirement it no longer meant.
    //
    // Ingest makes that an ordinary sequence rather than a corner case: a
    // reviewer approving, the branch moving, and the same reviewer asking for
    // changes is what review on GitHub looks like. So the rule matches the
    // incumbent's, for the same reason #121 gave for author-independence — a
    // requirement that binds self-attestation must not be weaker than GitHub's.
    const approvals = await latestReviewPerReviewer(db, proposal.id);
    const independent = approvals.filter((a) => a.reviewerId !== proposal.authorId);
    if (independent.length === 0) {
      unmet.push({
        requirement: "one_approval",
        problem:
          approvals.length === 0
            ? "no approving review"
            : "the only approving review is the proposal author's own",
        // The remedy has to name the *whose*, not just the what: since #121 an
        // approval from the author is not an approval, so "approve it" is
        // advice that does not work when followed by the person reading it.
        remedy: "have a principal other than the author approve it — as that principal, run",
        command: `gh pr review ${proposal.number} --approve`,
      });
    }
  }

  return { allowed: unmet.length === 0, unmet, advisories, quarantined };
}

// Every reviewer's latest standing verdict, as GitHub computes it: the most
// recent review that expressed one, with `commented` ignored because a comment
// is not a verdict and must not displace the approval it was left beside. A
// dismissed review is excluded outright — the review happened, which is why the
// row is kept rather than deleted, and it no longer counts.
async function latestReviewPerReviewer(db: Db, proposalId: string): Promise<{ reviewerId: string }[]> {
  const rows = await db
    .select({
      reviewerId: reviews.reviewerId,
      state: reviews.state,
      createdAt: reviews.createdAt,
      dismissedAt: reviews.dismissedAt,
    })
    .from(reviews)
    .where(eq(reviews.proposalId, proposalId))
    .orderBy(asc(reviews.createdAt));

  const latest = new Map<string, string>();
  for (const row of rows) {
    if (row.dismissedAt) {
      // A dismissal removes that verdict; it does not reinstate an older one,
      // which is also how GitHub behaves.
      latest.delete(row.reviewerId);
      continue;
    }
    if (row.state === "commented") continue;
    latest.set(row.reviewerId, row.state);
  }
  return [...latest.entries()].filter(([, state]) => state === "approved").map(([reviewerId]) => ({ reviewerId }));
}

function confidenceFailures(
  gates: string[],
  quarantinedNames: Set<string>,
  latest: Map<string, { status: string }>,
  stats: Map<string, FlakeStats>,
  statistical: StatisticalPolicy,
  gateUnmet: (requirement: string, gate: string) => UnmetRequirement,
  baseRef: string,
): UnmetRequirement[] {
  const failures: UnmetRequirement[] = [];
  for (const name of gates) {
    if (quarantinedNames.has(name)) continue;

    // Whatever the statistics say, a gate that is not green right now has not
    // passed. The confidence bound is an *additional* bar, never a way to land
    // over a red gate on the strength of its history.
    if (latest.get(name)?.status !== "success") {
      failures.push(gateUnmet("gates_confident", name));
      continue;
    }

    const s = stats.get(name);
    if (!statistical.enabled || !s || s.runs < statistical.min_runs) continue;

    const bound = wilsonLowerBound(s.successes, s.runs, statistical.confidence);
    if (bound < statistical.min_pass_rate) {
      failures.push({
        requirement: "gates_confident",
        problem:
          `${name} passed ${s.successes}/${s.runs} recent runs, a ${statistical.confidence} lower bound of ` +
          `${bound.toFixed(3)}, below min_pass_rate ${statistical.min_pass_rate}`,
        // No command: this one is not satisfied by anything typed at a
        // terminal. The gate is green *now*; the requirement is that its
        // history says that is reliable, so the only honest routes are more
        // passing runs or a policy that asks for less confidence.
        remedy:
          `the gate is green but its history is not yet trusted — either accumulate more passing runs, ` +
          `or lower land.statistical.min_pass_rate in adp.yaml on '${baseRef}'`,
      });
    }
  }
  return failures;
}
