import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { GitBackend } from "./git-backend.js";

// "Land policy, resolved two-level: instance
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

// M4-9c: what ADP's own runner executes, additive to the `gates` list above
// rather than a second meaning for it. `gates` (string names) is who land
// policy waits on and stays satisfiable by any reporter — self-reported CI,
// upstream Actions ingest, or this. `runner.gates` is ADP-run gates
// specifically: each entry's `run` is the command M4-9b's isolated executor
// runs for a pushed sha, and a repo names the *same* gate name in both lists
// when it wants ADP itself to be the one producing that evidence. A repo
// with no `runner:` block just never has ADP-run gates — nothing here is
// required.
const RunnerGateSchema = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
  // Same ceiling http-rest/gate-jobs.ts's EnqueueBody enforces.
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(30 * 60 * 1000)
    .default(5 * 60 * 1000),
});

const RunnerPolicySchema = z.object({
  image: z.string().min(1),
  setup: z.string().optional(),
  gates: z.array(RunnerGateSchema).default([]),
});

export type RunnerPolicy = z.infer<typeof RunnerPolicySchema>;

// #148: what happens when the secret detector fires on a trajectory event.
//
// Defaults to `redact`, and that default is the decision rather than a
// convenience. Refusing the batch loses the trajectory, and a lost trajectory
// teaches a user to turn recording off — which costs the record everything and
// costs the secret nothing, since it was already on their disk. Redaction
// keeps the trajectory, removes the secret from the durable copy, and says so
// where a reader will see it. `refuse` exists for the deployment that would
// rather have the gap than the risk, and is opt-in because that is a trade
// only they can price.
//
// #199: what is stored when the detector fires on *nothing*, which is the
// larger surface. `structure` keeps the payload's shape — its objects, arrays,
// keys, numbers and how long each string was — and drops the string content,
// recording a digest of what was supplied so a producer holding its own copy
// can still prove correspondence. `full` stores payloads as supplied.
//
// Defaults to `structure`, and the asymmetry is the whole argument: a repo can
// widen this to `full` after reading what a trajectory holds, and cannot
// unsend what already arrived.
const TrajectoryPolicySchema = z.object({
  on_secret: z.enum(["redact", "refuse"]).default("redact"),
  payloads: z.enum(["structure", "full"]).default("structure"),
});

export type TrajectoryPolicy = z.infer<typeof TrajectoryPolicySchema>;

const RepoPolicySchema = z.object({
  gates: z.array(z.string().min(1)).default([]),
  trajectory: TrajectoryPolicySchema.default({}),
  land: z
    .object({
      require: z.array(LandRequirement).default([]),
      statistical: StatisticalPolicySchema.default({}),
    })
    .default({ require: [], statistical: {} }),
  runner: RunnerPolicySchema.optional(),
});

export interface RepoPolicy {
  gates: string[];
  land: { require: LandRequirement[]; statistical: StatisticalPolicy };
  trajectory: TrajectoryPolicy;
  runner?: RunnerPolicy;
}

export const DEFAULT_STATISTICAL_POLICY: StatisticalPolicy = StatisticalPolicySchema.parse({});

export const DEFAULT_TRAJECTORY_POLICY: TrajectoryPolicy = TrajectoryPolicySchema.parse({});

// A malformed `adp.yaml` fails closed on land — every known requirement — for
// the reason stated below: a broken policy file must not quietly stop
// enforcing anything.
//
// #148: it does *not* fail closed to `refuse` on the trajectory side, and the
// asymmetry is the point. Both modes remove the secret — `redact` stores the
// event with the match replaced, `refuse` stores nothing — so there is no
// safety to buy by failing closed here, only a trajectory to lose. Failing
// closed is for a choice between "enforced" and "not enforced"; this is a
// choice between two enforced outcomes.
//
// #199's `payloads` needs no such carve-out: a malformed file leaves it at
// `structure`, which is both the default and the narrower of the two. Failing
// closed and falling back to the default coincide here, which is the shape a
// default should have.
const MALFORMED_POLICY: RepoPolicy = {
  gates: [],
  land: { require: [...LandRequirement.options], statistical: DEFAULT_STATISTICAL_POLICY },
  trajectory: DEFAULT_TRAJECTORY_POLICY,
};

export const EMPTY_POLICY: RepoPolicy = {
  gates: [],
  land: { require: [], statistical: DEFAULT_STATISTICAL_POLICY },
  trajectory: DEFAULT_TRAJECTORY_POLICY,
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
    return MALFORMED_POLICY;
  }

  const result = RepoPolicySchema.safeParse(parsed ?? {});
  if (!result.success) {
    return MALFORMED_POLICY;
  }
  return result.data;
}

// Union, not override: each level is a minimum the next can only add to,
// never remove from ("instance floor ∧
// repo adp.yaml"; generalized to instance ∧ org ∧ repo by M4-2.
// `orgFloor` is `[]` for a repo with no
// org and for an org with no policy repo designated — same "empty, not an
// error" default the instance floor and repo policy already use.
export function resolveLandRequirements(
  instanceFloor: LandRequirement[],
  orgFloor: LandRequirement[],
  repoPolicy: RepoPolicy,
): LandRequirement[] {
  return [...new Set([...instanceFloor, ...orgFloor, ...repoPolicy.land.require])];
}
