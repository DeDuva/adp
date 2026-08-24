import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { gateResults } from "../db/schema.js";

// M3, the A8 contribution:
// statistical land criteria. Two questions about a gate, both answered from
// `gate_results` alone:
//
//   is it flaky?    — does it disagree with itself on the same commit
//   is it passing?  — with what confidence, given how few runs we have
//
// Everything here is *derived*. `gate_results` already keeps every rerun rather
// than overwriting (see its schema comment), so a `gate_flake_stats` table would
// be a denormalization of data we already have — a second source of truth that
// can drift from the first, which the plan rules out on principle.

export interface FlakeStats {
  /** Results examined (the trailing window, newest first). */
  runs: number;
  /** Distinct commits those results covered. */
  distinctShas: number;
  /** Commits where this gate reported both success and failure — it disagreed with itself. */
  flips: number;
  /** flips / distinctShas. Zero when there is nothing to divide. */
  flakeRate: number;
  /** Successes among `runs`, used for the confidence bound. */
  successes: number;
  /** Observed pass rate, successes / runs. */
  passRate: number;
}

export const EMPTY_FLAKE_STATS: FlakeStats = {
  runs: 0,
  distinctShas: 0,
  flips: 0,
  flakeRate: 0,
  successes: 0,
  passRate: 0,
};

// `pending` is excluded from both statistics deliberately: it is "no verdict
// yet", not evidence about the gate's behaviour, and counting it as a failure
// would make every in-flight gate look flaky.
export async function gateFlakeStats(db: Db, repoId: string, gateName: string, window: number): Promise<FlakeStats> {
  const rows = await db
    .select({ gitSha: gateResults.gitSha, status: gateResults.status })
    .from(gateResults)
    .where(and(eq(gateResults.repoId, repoId), eq(gateResults.name, gateName)))
    .orderBy(desc(gateResults.createdAt))
    .limit(window);

  const verdicts = rows.filter((r) => r.status !== "pending");
  if (verdicts.length === 0) return EMPTY_FLAKE_STATS;

  const bySha = new Map<string, { success: boolean; failure: boolean }>();
  let successes = 0;
  for (const row of verdicts) {
    if (row.status === "success") successes++;
    const seen = bySha.get(row.gitSha) ?? { success: false, failure: false };
    if (row.status === "success") seen.success = true;
    else seen.failure = true;
    bySha.set(row.gitSha, seen);
  }

  const distinctShas = bySha.size;
  const flips = [...bySha.values()].filter((s) => s.success && s.failure).length;

  return {
    runs: verdicts.length,
    distinctShas,
    flips,
    flakeRate: distinctShas === 0 ? 0 : flips / distinctShas,
    successes,
    passRate: successes / verdicts.length,
  };
}

// Lower bound of the Wilson score interval for a binomial proportion.
//
// Wilson rather than the normal ("Wald") approximation, and the difference is
// not academic here: at the small n a gate history actually has — five runs,
// ten — Wald is wrong in the permissive direction. Five successes out of five
// gives a Wald interval of exactly [1, 1] — p̂ = 1 means zero estimated
// variance — so a gate that has never been observed to fail would clear any
// threshold with total confidence on the strength of five observations. Wilson
// gives ≈0.649 at 95%, which is the honest answer, and honest is the entire
// point of a statistical gate.
export function wilsonLowerBound(successes: number, n: number, confidence: number): number {
  if (n <= 0) return 0;
  const z = zForOneSidedConfidence(confidence);
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, center - margin);
}

// One-sided z for a lower bound: we are asking "how low could the true pass
// rate plausibly be", not bracketing it from both sides, so 95% confidence is
// z ≈ 1.645 rather than the two-sided 1.96.
export function zForOneSidedConfidence(confidence: number): number {
  const clamped = Math.min(Math.max(confidence, 0.5), 0.999999);
  return inverseStandardNormalCdf(clamped);
}

// Acklam's rational approximation to the inverse standard normal CDF —
// |relative error| < 1.15e-9 across the whole domain, which is far tighter than
// anything this needs and avoids hard-coding a table of z values that would
// silently mis-answer any confidence not in the table.
function inverseStandardNormalCdf(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}
