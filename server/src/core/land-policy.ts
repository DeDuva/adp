import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "./git-backend.js";
import { reviews } from "../db/schema.js";
import { loadRepoPolicy, resolveLandRequirements, type LandRequirement } from "./repo-policy.js";
import { latestGateResults, allGatesGreen } from "./gate-results-lookup.js";

export interface LandPolicyResult {
  allowed: boolean;
  unmet: string[];
}

// The M1c land-policy gate: instance floor ∧ repo adp.yaml
// (docs/pragmatic_mvp.md §1.5 item 2). Repo policy is read off the *base*
// ref — the branch being landed into, same as GitHub reads branch
// protection off the target branch, not the PR's head.
export async function evaluateLandPolicy(
  db: Db,
  gitBackend: GitBackend,
  instanceFloor: LandRequirement[],
  repo: { id: string; owner: string; name: string },
  proposal: { id: string; baseRef: string; headSha: string },
): Promise<LandPolicyResult> {
  const repoPolicy = await loadRepoPolicy(gitBackend, repo.owner, repo.name, proposal.baseRef);
  const required = resolveLandRequirements(instanceFloor, repoPolicy);
  const unmet: string[] = [];

  if (required.includes("gates_green")) {
    const latest = await latestGateResults(db, repo.id, proposal.headSha);
    if (!allGatesGreen(repoPolicy.gates, latest)) {
      const failing = repoPolicy.gates.filter((name) => latest.get(name)?.status !== "success");
      unmet.push(
        failing.length > 0
          ? `gates_green: ${failing.join(", ")} not green`
          : "gates_green: no gate results reported for this commit",
      );
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

  return { allowed: unmet.length === 0, unmet };
}
