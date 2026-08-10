import { and, eq } from "drizzle-orm";
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

export interface LandPolicyResult {
  allowed: boolean;
  unmet: string[];
  /**
   * Things that did not block the land but that a caller must be able to see.
   * A quarantined gate is the case this exists for: a gate that silently stops
   * mattering is worse than a flaky gate.
   */
  advisories: string[];
  quarantined: QuarantinedGate[];
}

// The M1c land-policy gate: instance floor ∧ repo adp.yaml
// (docs/pragmatic_mvp.md §1.5 item 2). Repo policy is read off the *base*
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
  proposal: { id: string; baseRef: string; headSha: string },
  org: OrgLandContext | null = null,
): Promise<LandPolicyResult> {
  // Checked first and unconditionally: a killed org refuses every land for
  // every repo in it, before any gate, review, or statistic is even loaded.
  if (org?.killSwitch) {
    return { allowed: false, unmet: ["org kill switch is active"], advisories: [], quarantined: [] };
  }

  const repoPolicy = await loadRepoPolicy(gitBackend, repo.owner, repo.name, proposal.baseRef);
  const orgPolicy = await loadOrgPolicy(gitBackend, org?.policyRepo ?? null);
  const required = resolveLandRequirements(instanceFloor, orgPolicy.land.require, repoPolicy);
  const statistical = repoPolicy.land.statistical;
  const unmet: string[] = [];
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
      unmet.push(
        failing.length > 0
          ? `gates_green: ${failing.join(", ")} not green`
          : "gates_green: no gate results reported for this commit",
      );
    }
  }

  if (required.includes("gates_confident")) {
    const failures = confidenceFailures(repoPolicy.gates, quarantinedNames, latest, stats, statistical);
    if (failures.length > 0) unmet.push(`gates_confident: ${failures.join("; ")}`);

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
    const approvals = await db
      .select()
      .from(reviews)
      .where(and(eq(reviews.proposalId, proposal.id), eq(reviews.state, "approved")));
    if (approvals.length === 0) {
      unmet.push("one_approval: no approving review");
    }
  }

  return { allowed: unmet.length === 0, unmet, advisories, quarantined };
}

function confidenceFailures(
  gates: string[],
  quarantinedNames: Set<string>,
  latest: Map<string, { status: string }>,
  stats: Map<string, FlakeStats>,
  statistical: StatisticalPolicy,
): string[] {
  const failures: string[] = [];
  for (const name of gates) {
    if (quarantinedNames.has(name)) continue;

    // Whatever the statistics say, a gate that is not green right now has not
    // passed. The confidence bound is an *additional* bar, never a way to land
    // over a red gate on the strength of its history.
    if (latest.get(name)?.status !== "success") {
      failures.push(`${name} is not green`);
      continue;
    }

    const s = stats.get(name);
    if (!statistical.enabled || !s || s.runs < statistical.min_runs) continue;

    const bound = wilsonLowerBound(s.successes, s.runs, statistical.confidence);
    if (bound < statistical.min_pass_rate) {
      failures.push(
        `${name} pass rate ${s.successes}/${s.runs} gives a ${statistical.confidence} lower bound of ` +
          `${bound.toFixed(3)}, below min_pass_rate ${statistical.min_pass_rate}`,
      );
    }
  }
  return failures;
}
