import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { changes, gateResults } from "../db/schema.js";

export interface EvidenceBundle {
  git_sha: string;
  change: {
    id: string;
    intent_id: string | null;
    provenance: unknown;
    signature: string;
    created_at: string;
  } | null;
  gates: {
    name: string;
    status: string;
    summary: string;
    envelope: unknown;
    created_at: string;
  }[];
}

// "adp_evidence_get — full signed bundle for a change" (
// Tier 4). Not a new source of truth — a read that assembles what's already
// signed and stored elsewhere: the change record (core/signing.ts) and every
// gate result reported for that commit (core/dsse.ts), most-recent-first.
export async function getEvidenceBundle(db: Db, repoId: string, gitSha: string): Promise<EvidenceBundle> {
  // #143 made (repo_id, git_sha) unique, so this can match at most one row.
  // The ordering and the limit stay anyway: this read is what decides whether
  // an evidence bundle shows an intent at all, and it should not be the
  // constraint alone standing between that answer and an arbitrary one. If a
  // future write path ever reintroduces a second row, this returns the oldest
  // — the push's record — deterministically, rather than whatever the plan
  // happened to yield.
  const [change] = await db
    .select()
    .from(changes)
    .where(and(eq(changes.repoId, repoId), eq(changes.gitSha, gitSha)))
    .orderBy(asc(changes.createdAt), asc(changes.id))
    .limit(1);

  const gateRows = await db
    .select()
    .from(gateResults)
    .where(and(eq(gateResults.repoId, repoId), eq(gateResults.gitSha, gitSha)));

  return {
    git_sha: gitSha,
    change: change
      ? {
          id: change.id,
          intent_id: change.intentId,
          provenance: change.provenance,
          signature: change.signature,
          created_at: change.createdAt.toISOString(),
        }
      : null,
    gates: gateRows
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((row) => ({
        name: row.name,
        status: row.status,
        summary: row.summary,
        envelope: row.envelope,
        created_at: row.createdAt.toISOString(),
      })),
  };
}
