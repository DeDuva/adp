import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { GitBackend } from "./git-backend.js";
import { LandRequirement } from "./repo-policy.js";

// M4-2 (docs/m4-readiness-review.md §4): an org's floor, read from
// `policy.yaml` on the default branch of the repo it designates
// (orgs.policyRepoId). Deliberately narrower than a repo's own adp.yaml —
// just `land.require` for now, not gates or statistical policy, which stay
// repo-scoped concerns. Same fail-closed rule as loadRepoPolicy: a
// malformed file is treated as requiring everything known, not silently
// ignored, because a broken policy file is exactly the kind of thing that
// must not quietly stop enforcing anything — doubly so at the org level,
// where one bad file affects every repo in the org at once.
const OrgPolicySchema = z.object({
  land: z
    .object({
      require: z.array(LandRequirement).default([]),
    })
    .default({ require: [] }),
});

export interface OrgPolicy {
  land: { require: LandRequirement[] };
}

export const EMPTY_ORG_POLICY: OrgPolicy = { land: { require: [] } };
const FAIL_CLOSED_ORG_POLICY: OrgPolicy = { land: { require: [...LandRequirement.options] } };

// `policyRepo` is null when the org has designated no policy repo — every
// org today, until something sets orgs.policyRepoId, which this slice does
// not yet expose a route to do (M4-2's PR description records that as a
// deliberate, narrow scope: the resolution mechanism is what this item
// builds, not an org-management console — that's M4-7).
export async function loadOrgPolicy(
  gitBackend: GitBackend,
  policyRepo: { owner: string; name: string; defaultBranch: string } | null,
): Promise<OrgPolicy> {
  if (!policyRepo) return EMPTY_ORG_POLICY;

  const stat = await gitBackend.statPath(policyRepo.owner, policyRepo.name, policyRepo.defaultBranch, "policy.yaml");
  if (!stat || stat.type !== "blob") return EMPTY_ORG_POLICY;

  const raw = await gitBackend.readBlob(policyRepo.owner, policyRepo.name, stat.sha);
  let parsed: unknown;
  try {
    parsed = parseYaml(raw.toString("utf8"));
  } catch {
    return FAIL_CLOSED_ORG_POLICY;
  }

  const result = OrgPolicySchema.safeParse(parsed ?? {});
  if (!result.success) return FAIL_CLOSED_ORG_POLICY;
  return result.data;
}
