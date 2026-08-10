import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { GitBackend } from "./git-backend.js";

// docs/pragmatic_mvp.md M1c: "Land policy, resolved two-level: instance
// floor ∧ repo adp.yaml (require: [gates_green, one_approval], risk tiers
// by path glob)." Risk tiers by path glob are not implemented in this
// slice — `require` is repo-wide, not conditioned on what changed.
export const LandRequirement = z.enum(["gates_green", "one_approval", "gates_confident"]);
export type LandRequirement = z.infer<typeof LandRequirement>;

// M3, statistical land criteria v0 (the A8 contribution). Defaults are chosen
// to be inert: with `enabled: false` nothing about land policy changes, so a
// repo opts in the same way it opts into any other gate.
const StatisticalPolicySchema = z.object({
  enabled: z.boolean().default(true),
  /** Trailing gate results per gate to compute statistics over. */
  window: z.number().int().min(1).max(1000).default(20),
  /** Below this many observed verdicts, `gates_confident` falls back to `gates_green`. */
  min_runs: z.number().int().min(1).default(5),
  confidence: z.number().min(0.5).max(0.999999).default(0.95),
  /** The Wilson lower bound a gate's pass rate must clear for `gates_confident`. */
  min_pass_rate: z.number().min(0).max(1).default(0.9),
  /** Above this flake rate, a gate is quarantined: it stops blocking, visibly. */
  quarantine_threshold: z.number().min(0).max(1).default(0.2),
});

export type StatisticalPolicy = z.infer<typeof StatisticalPolicySchema>;

const RepoPolicySchema = z.object({
  gates: z.array(z.string().min(1)).default([]),
  land: z
    .object({
      require: z.array(LandRequirement).default([]),
      statistical: StatisticalPolicySchema.default({}),
    })
    .default({ require: [], statistical: {} }),
});

export interface RepoPolicy {
  gates: string[];
  land: { require: LandRequirement[]; statistical: StatisticalPolicy };
}

export const DEFAULT_STATISTICAL_POLICY: StatisticalPolicy = StatisticalPolicySchema.parse({});

export const EMPTY_POLICY: RepoPolicy = {
  gates: [],
  land: { require: [], statistical: DEFAULT_STATISTICAL_POLICY },
};

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
    return { gates: [], land: { require: [...LandRequirement.options], statistical: DEFAULT_STATISTICAL_POLICY } };
  }

  const result = RepoPolicySchema.safeParse(parsed ?? {});
  if (!result.success) {
    return { gates: [], land: { require: [...LandRequirement.options], statistical: DEFAULT_STATISTICAL_POLICY } };
  }
  return result.data;
}

// Union, not override: each level is a minimum the next can only add to,
// never remove from (docs/pragmatic_mvp.md §1.5 item 2 — "instance floor ∧
// repo adp.yaml"; generalized to instance ∧ org ∧ repo by M4-2,
// docs/m4-readiness-review.md §4). `orgFloor` is `[]` for a repo with no
// org and for an org with no policy repo designated — same "empty, not an
// error" default the instance floor and repo policy already use.
export function resolveLandRequirements(
  instanceFloor: LandRequirement[],
  orgFloor: LandRequirement[],
  repoPolicy: RepoPolicy,
): LandRequirement[] {
  return [...new Set([...instanceFloor, ...orgFloor, ...repoPolicy.land.require])];
}
