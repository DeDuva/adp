import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { candidateSets, proposals, intents } from "../db/schema.js";
import { recordOperation } from "./operations.js";

export interface OpenCandidateSetResult {
  ok: true;
  candidateSet: typeof candidateSets.$inferSelect;
}
export interface CandidateSetError {
  ok: false;
  message: string;
}

// Candidate sets (docs/pragmatic_mvp.md §2.2, the one MVP feature GitHub
// structurally cannot express): N proposals fanned out against one intent,
// one selected. Opening a set just creates the row the intent's candidates
// will join via `proposals.candidateSetId` — proposal creation is what
// actually adds a member (http-rest/proposals.ts's `candidate_set_id` field).
export async function openCandidateSet(
  db: Db,
  repo: { id: string; owner: string; name: string },
  intentId: string,
  selectionPolicy: string,
  actorId: string,
): Promise<OpenCandidateSetResult | CandidateSetError> {
  const [intent] = await db.select().from(intents).where(and(eq(intents.id, intentId), eq(intents.repoId, repo.id)));
  if (!intent) {
    return { ok: false, message: `intent ${intentId} not found in this repository` };
  }

  const candidateSet = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(candidateSets)
      .values({ repoId: repo.id, intentId, selectionPolicy })
      .returning();

    await recordOperation(tx, {
      actorId,
      verb: "candidateset.open",
      target: `${repo.owner}/${repo.name}@candidateset:${row!.id}`,
      after: { id: row!.id, intentId, selectionPolicy },
    });

    return row!;
  });

  return { ok: true, candidateSet };
}

export interface SelectCandidateResult {
  ok: true;
  candidateSet: typeof candidateSets.$inferSelect;
}

export async function selectCandidate(
  db: Db,
  repo: { id: string; owner: string; name: string },
  candidateSetId: string,
  proposalId: string,
  actorId: string,
): Promise<SelectCandidateResult | CandidateSetError> {
  const [candidateSet] = await db
    .select()
    .from(candidateSets)
    .where(and(eq(candidateSets.id, candidateSetId), eq(candidateSets.repoId, repo.id)));
  if (!candidateSet) {
    return { ok: false, message: `candidate set ${candidateSetId} not found in this repository` };
  }

  const [proposal] = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, proposalId), eq(proposals.candidateSetId, candidateSetId)));
  if (!proposal) {
    return { ok: false, message: `proposal ${proposalId} is not a candidate in this set` };
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(candidateSets)
      .set({ selectedProposalId: proposalId })
      .where(eq(candidateSets.id, candidateSetId))
      .returning();

    await recordOperation(tx, {
      actorId,
      verb: "candidateset.select",
      target: `${repo.owner}/${repo.name}@candidateset:${candidateSetId}`,
      before: { selectedProposalId: candidateSet.selectedProposalId },
      after: { selectedProposalId: proposalId },
    });

    return row!;
  });

  return { ok: true, candidateSet: updated };
}

export async function listCandidates(db: Db, candidateSetId: string) {
  return db.select().from(proposals).where(eq(proposals.candidateSetId, candidateSetId));
}
