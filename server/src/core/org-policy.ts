import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { GitBackend } from "./git-backend.js";
import { LandRequirement } from "./repo-policy.js";

// M4-2: an org's floor, read from
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

// Where the floor an org is currently enforcing actually came from. M4-7
// added this: `loadOrgPolicy` alone cannot distinguish an org that
// deliberately requires everything from one whose policy.yaml is malformed
// and is being failed closed — the two return an identical policy, which is
// the correct enforcement decision and a terrible thing to show an operator
// without comment. The console renders "no policy repo", "no file", "this
// file is broken and you are being failed closed" and "this is what you
// asked for" differently (http-rest/orgs.ts, web/src/components/OrgConsole.tsx).
export type OrgPolicySource = "no_policy_repo" | "no_policy_file" | "ok" | "malformed";

export interface OrgPolicyResolution {
  policy: OrgPolicy;
  source: OrgPolicySource;
}

// `policyRepo` is null when the org has designated no policy repo — the state
// every org starts in, and one an operator has to be able to see, because an
// org with no policy repo contributes nothing to the floor no matter what
// anyone believes it is enforcing.
export async function describeOrgPolicy(
  gitBackend: GitBackend,
  policyRepo: { owner: string; name: string; defaultBranch: string } | null,
): Promise<OrgPolicyResolution> {
  if (!policyRepo) return { policy: EMPTY_ORG_POLICY, source: "no_policy_repo" };

  const stat = await gitBackend.statPath(policyRepo.owner, policyRepo.name, policyRepo.defaultBranch, "policy.yaml");
  if (!stat || stat.type !== "blob") return { policy: EMPTY_ORG_POLICY, source: "no_policy_file" };

  const raw = await gitBackend.readBlob(policyRepo.owner, policyRepo.name, stat.sha);
  let parsed: unknown;
  try {
    parsed = parseYaml(raw.toString("utf8"));
  } catch {
    return { policy: FAIL_CLOSED_ORG_POLICY, source: "malformed" };
  }

  const result = OrgPolicySchema.safeParse(parsed ?? {});
  if (!result.success) return { policy: FAIL_CLOSED_ORG_POLICY, source: "malformed" };
  return { policy: result.data, source: "ok" };
}

// The enforcement path's entry point, unchanged in behaviour and signature:
// land policy needs the floor, not the story behind it.
export async function loadOrgPolicy(
  gitBackend: GitBackend,
  policyRepo: { owner: string; name: string; defaultBranch: string } | null,
): Promise<OrgPolicy> {
  const { policy } = await describeOrgPolicy(gitBackend, policyRepo);
  return policy;
}
