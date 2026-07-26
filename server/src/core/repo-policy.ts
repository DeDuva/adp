import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { GitBackend } from "./git-backend.js";

// docs/pragmatic_mvp.md M1c: "Land policy, resolved two-level: instance
// floor ∧ repo adp.yaml (require: [gates_green, one_approval], risk tiers
// by path glob)." Risk tiers by path glob are not implemented in this
// slice — `require` is repo-wide, not conditioned on what changed.
export const LandRequirement = z.enum(["gates_green", "one_approval"]);
export type LandRequirement = z.infer<typeof LandRequirement>;

const RepoPolicySchema = z.object({
  gates: z.array(z.string().min(1)).default([]),
  land: z
    .object({
      require: z.array(LandRequirement).default([]),
    })
    .default({ require: [] }),
});

export interface RepoPolicy {
  gates: string[];
  land: { require: LandRequirement[] };
}

export const EMPTY_POLICY: RepoPolicy = { gates: [], land: { require: [] } };

// `adp.yaml` is optional — a repo with none just runs under the instance
// floor alone. A malformed file fails closed (treated as if it required
// every known requirement) rather than silently ignored, since a broken
// policy file is exactly the kind of thing that shouldn't quietly stop
// enforcing anything.
export async function loadRepoPolicy(
  gitBackend: GitBackend,
  owner: string,
  name: string,
  ref: string,
): Promise<RepoPolicy> {
  const stat = await gitBackend.statPath(owner, name, ref, "adp.yaml");
  if (!stat || stat.type !== "blob") return EMPTY_POLICY;

  const raw = await gitBackend.readBlob(owner, name, stat.sha);
  let parsed: unknown;
  try {
    parsed = parseYaml(raw.toString("utf8"));
  } catch {
    return { gates: [], land: { require: [...LandRequirement.options] } };
  }

  const result = RepoPolicySchema.safeParse(parsed ?? {});
  if (!result.success) {
    return { gates: [], land: { require: [...LandRequirement.options] } };
  }
  return result.data;
}

// Union, not override: the instance floor is a minimum the repo can only
// add to, never remove from (docs/pragmatic_mvp.md §1.5 item 2 — "instance
// floor ∧ repo adp.yaml").
export function resolveLandRequirements(instanceFloor: LandRequirement[], repoPolicy: RepoPolicy): LandRequirement[] {
  return [...new Set([...instanceFloor, ...repoPolicy.land.require])];
}
