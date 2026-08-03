import { and, eq, desc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { gateResults } from "../db/schema.js";

type GateResultRow = typeof gateResults.$inferSelect;

// Multiple rows can exist per (repoId, gitSha, name) — a rerun. Land policy
// and StatusCheckRollup projection only ever care about the most recent one.
export async function latestGateResults(db: Db, repoId: string, gitSha: string): Promise<Map<string, GateResultRow>> {
  const rows = await db
    .select()
    .from(gateResults)
    .where(and(eq(gateResults.repoId, repoId), eq(gateResults.gitSha, gitSha)))
    .orderBy(desc(gateResults.createdAt));

  const latest = new Map<string, GateResultRow>();
  for (const row of rows) {
    if (!latest.has(row.name)) latest.set(row.name, row);
  }
  return latest;
}

// "gates_green" (core/repo-policy.ts) means every gate the repo's adp.yaml
// names under `gates:` has a latest result of "success" — a gate that never
// reported is not green (silence isn't success), and "pending" isn't either.
// Takes only what it reads — a status per gate name — rather than the whole
// row, so callers that already narrowed their projection don't have to widen it
// back out just to satisfy a signature.
export function allGatesGreen(requiredGateNames: string[], latest: Map<string, { status: string }>): boolean {
  return requiredGateNames.every((name) => latest.get(name)?.status === "success");
}
