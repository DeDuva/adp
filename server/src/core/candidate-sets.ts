import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "./git-backend.js";
import { candidateSets, proposals, intents, workspaces } from "../db/schema.js";
import { recordOperation } from "./operations.js";
import { evaluateLandPolicy, type UnmetRequirement } from "./land-policy.js";
import { findOrgLandContext } from "./org-lookup.js";
import { latestGateResults } from "./gate-results-lookup.js";
import { decodeStatement, type DsseEnvelope } from "./dsse.js";
import { landProposal, type LandDeps } from "./land.js";
import { destroyWorkspace } from "./workspaces.js";

export type SelectionPolicy = "manual" | "first_green" | "best_score";
export const SELECTION_POLICIES: readonly SelectionPolicy[] = ["manual", "first_green", "best_score"];

// The gate name a candidate's score is reported under. It is an ordinary gate
// result — no new evidence path, no new table — so a scorer is just another
// thing that POSTs to .../gates, same as every other gate.
export const SCORE_GATE_NAME = "score";

export interface OpenCandidateSetResult {
  ok: true;
  candidateSet: typeof candidateSets.$inferSelect;
}
export interface CandidateSetError {
  ok: false;
  message: string;
}

// Candidate sets (the one MVP feature GitHub
// structurally cannot express): N proposals fanned out against one intent,
// one selected. Opening a set just creates the row the intent's candidates
// will join via `proposals.candidateSetId` — proposal creation is what
// actually adds a member (http-rest/proposals.ts's `candidate_set_id` field).
export async function openCandidateSet(
  db: Db,
  repo: { id: string; owner: string; name: string },
  intentId: string,
  selectionPolicy: SelectionPolicy,
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
      repoId: repo.id,
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
      repoId: repo.id,
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
  return db.select().from(proposals).where(eq(proposals.candidateSetId, candidateSetId)).orderBy(asc(proposals.number));
}

// A candidate's score, read from the ordinary `score` gate result on its head
// commit. The number lives in the DSSE statement's predicate rather than in a
// column, so scoring needs no schema of its own and the score arrives signed
// like any other piece of evidence. A candidate with no score gate, or one
// whose predicate carries no numeric `score`, has no score — it is not zero,
// and best_score will not rank it against candidates that were measured.
export async function candidateScore(db: Db, repoId: string, headSha: string): Promise<number | null> {
  const latest = await latestGateResults(db, repoId, headSha);
  const row = latest.get(SCORE_GATE_NAME);
  if (!row || row.status !== "success") return null;
  try {
    const statement = decodeStatement(row.envelope as DsseEnvelope);
    const score = (statement.predicate as { score?: unknown } | null)?.score;
    return typeof score === "number" && Number.isFinite(score) ? score : null;
  } catch {
    return null;
  }
}

export interface ResolveCandidateSetResult {
  ok: true;
  candidateSet: typeof candidateSets.$inferSelect;
  landed: typeof proposals.$inferSelect;
  /**
   * The squash commit this call produced, or null when the land had already
   * happened before this call — a resolution that was interrupted after landing
   * and is being completed. Null is the honest answer there: the sha belongs to
   * the interrupted call, not this one.
   */
  sha: string | null;
  reclaimed: { proposalId: string; workspaceId: string | null }[];
}
export interface ResolveCandidateSetError {
  ok: false;
  status: 409 | 422;
  message: string;
  unmet?: UnmetRequirement[];
}

// D1's second half: a fanned-out set *resolves*. Pick a winner by the set's own
// selection policy, land it through the shared land path (core/land.ts — the
// same policy, the same evidence, the same signed change as any other merge),
// then reclaim the losers.
//
// Reclamation destroys the losing candidates' workspace refs and closes their
// proposals. It never deletes a row: D1's whole point is that the 49 discarded
// attempts stay *queryable* while staying out of the landed history, so what is
// reclaimed is the git ref, not the record of the attempt.
//
// Land here is serial, not speculatively batched — see core/land.ts.
export async function resolveCandidateSet(
  deps: LandDeps,
  gitBackend: GitBackend,
  repo: { id: string; owner: string; name: string; orgId: string | null },
  candidateSetId: string,
  actor: { identityId: string; principal: string },
  explicitProposalId?: string,
): Promise<ResolveCandidateSetResult | ResolveCandidateSetError> {
  const { db } = deps;

  const [candidateSet] = await db
    .select()
    .from(candidateSets)
    .where(and(eq(candidateSets.id, candidateSetId), eq(candidateSets.repoId, repo.id)));
  if (!candidateSet) {
    return { ok: false, status: 422, message: `candidate set ${candidateSetId} not found in this repository` };
  }
  if (candidateSet.status !== "open") {
    return { ok: false, status: 422, message: `candidate set is already ${candidateSet.status}` };
  }

  const allCandidates = await listCandidates(db, candidateSetId);
  const candidates = allCandidates.filter((c) => c.state === "open");

  // Resolving is three steps that cannot be one transaction: land the winner
  // (git *and* Postgres), reclaim the losers, mark the set resolved. An
  // interruption between the first and the last leaves a set that is still
  // `open` but already has a merged candidate.
  //
  // Re-entering must not treat that as "no winner yet and several candidates
  // still open" and go land a second one. In practice the fast-forward
  // precondition would refuse the second land — the base has moved and no loser
  // is a descendant of it — so the "one landed change" invariant survives even
  // without this. But it survives by accident of another check, the caller gets
  // an opaque 409, and the set stays open with its losers half-reclaimed.
  // Completing idempotently is the behaviour that actually matches what the
  // caller asked for.
  const alreadyLanded = allCandidates.find((c) => c.state === "merged");

  let winnerProposal: typeof proposals.$inferSelect;
  let landedSha: string | null;

  if (alreadyLanded) {
    winnerProposal = alreadyLanded;
    // The squash commit's sha belongs to the interrupted call, not this one.
    // Null says "the land had already happened" rather than inventing a value.
    landedSha = null;
  } else {
    if (candidates.length === 0) {
      return { ok: false, status: 422, message: "candidate set has no open candidates" };
    }

    const winner = await pickWinner(deps, repo, candidateSet, candidates, explicitProposalId);
    if (!winner.ok) return winner;

    // Squash rather than a merge commit, and the choice is D1's own: "the money
    // shot is the history view — *one landed change*, intent attached, 49
    // discarded attempts queryable but not polluting history". A merge commit
    // would drag the winning candidate's whole exploratory history onto the base
    // ref, which is the opposite of that. Callers wanting other semantics merge
    // the proposal directly through the ordinary merge path instead.
    const landed = await landProposal(deps, repo, winner.proposal, "squash", actor);
    if (!landed.ok) {
      // The set stays open. A selected candidate that cannot satisfy land policy
      // is a gate doing its job, not a resolution — leaving the set open lets the
      // caller fix the gate result and resolve again, rather than forcing them to
      // reopen a set that never actually resolved.
      return { ok: false, status: landed.status, message: landed.message, unmet: landed.unmet };
    }
    winnerProposal = landed.proposal;
    landedSha = landed.sha;
  }

  const losers = candidates.filter((c) => c.id !== winnerProposal.id);
  const reclaimed: { proposalId: string; workspaceId: string | null }[] = [];

  for (const loser of losers) {
    // A proposal points at its branch, and a workspace *is* a branch
    // (core/workspaces.ts) — `head_ref` is the join, which is why reclamation
    // needs no new column. A candidate pushed from a plain branch rather than
    // an ADP workspace simply has nothing to reclaim.
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.repoId, repo.id), eq(workspaces.branch, loser.headRef)));

    if (workspace && !workspace.destroyedAt) {
      await destroyWorkspace(db, gitBackend, repo, workspace.id, actor.identityId);
    }

    await db.transaction(async (tx) => {
      await tx.update(proposals).set({ state: "closed", closedAt: new Date() }).where(eq(proposals.id, loser.id));

      await recordOperation(tx, {
        repoId: repo.id,
        actorId: actor.identityId,
        verb: "candidateset.reclaim",
        target: `${repo.owner}/${repo.name}#${loser.number}`,
        before: { state: loser.state },
        after: {
          state: "closed",
          candidateSetId,
          reason: "not selected",
          workspaceId: workspace?.id ?? null,
        },
      });
    });

    reclaimed.push({ proposalId: loser.id, workspaceId: workspace?.id ?? null });
  }

  const resolved = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(candidateSets)
      .set({ status: "resolved", resolvedAt: new Date(), selectedProposalId: winnerProposal.id })
      .where(eq(candidateSets.id, candidateSetId))
      .returning();

    await recordOperation(tx, {
      repoId: repo.id,
      actorId: actor.identityId,
      verb: "candidateset.resolve",
      target: `${repo.owner}/${repo.name}@candidateset:${candidateSetId}`,
      before: { status: candidateSet.status, selectedProposalId: candidateSet.selectedProposalId },
      after: {
        status: "resolved",
        selectedProposalId: winnerProposal.id,
        selectionPolicy: candidateSet.selectionPolicy,
        landedSha,
        reclaimedCount: reclaimed.length,
      },
    });

    return row!;
  });

  return { ok: true, candidateSet: resolved, landed: winnerProposal, sha: landedSha, reclaimed };
}

type WinnerResult = { ok: true; proposal: typeof proposals.$inferSelect } | ResolveCandidateSetError;

async function pickWinner(
  deps: LandDeps,
  repo: { id: string; owner: string; name: string; orgId: string | null },
  candidateSet: typeof candidateSets.$inferSelect,
  candidates: (typeof proposals.$inferSelect)[],
  explicitProposalId?: string,
): Promise<WinnerResult> {
  if (explicitProposalId) {
    const chosen = candidates.find((c) => c.id === explicitProposalId);
    if (!chosen) {
      return { ok: false, status: 422, message: `proposal ${explicitProposalId} is not an open candidate in this set` };
    }
    return { ok: true, proposal: chosen };
  }

  switch (candidateSet.selectionPolicy) {
    case "manual": {
      // `manual` means a human or an orchestrator decides. Resolving without a
      // selection is an error rather than a silent fallback to "the first one" —
      // guessing here would land code nobody chose.
      const selectedId = candidateSet.selectedProposalId;
      if (!selectedId) {
        return {
          ok: false,
          status: 422,
          message: "selection policy 'manual' requires an explicit selection before the set can resolve",
        };
      }
      const chosen = candidates.find((c) => c.id === selectedId);
      if (!chosen) {
        return { ok: false, status: 422, message: "the selected proposal is no longer an open candidate" };
      }
      return { ok: true, proposal: chosen };
    }

    case "first_green": {
      // Candidates come back ordered by proposal number, so "first" means the
      // earliest-opened candidate that can actually land — deterministic given
      // the same evidence, which is what a benchmark needs.
      const org = await findOrgLandContext(deps.db, repo.orgId);
      for (const candidate of candidates) {
        const policy = await evaluateLandPolicy(deps.db, deps.gitBackend, deps.instanceFloor, repo, candidate, org);
        if (policy.allowed) return { ok: true, proposal: candidate };
      }
      return { ok: false, status: 422, message: "selection policy 'first_green': no candidate satisfies land policy" };
    }

    case "best_score": {
      let best: { proposal: typeof proposals.$inferSelect; score: number } | null = null;
      for (const candidate of candidates) {
        const score = await candidateScore(deps.db, repo.id, candidate.headSha);
        if (score === null) continue;
        // Strictly greater, over candidates already ordered by number, makes
        // the tie-break "earliest proposal wins" without a second comparison.
        if (!best || score > best.score) best = { proposal: candidate, score };
      }
      if (!best) {
        return {
          ok: false,
          status: 422,
          message: `selection policy 'best_score': no candidate has a '${SCORE_GATE_NAME}' gate result to rank by`,
        };
      }
      return { ok: true, proposal: best.proposal };
    }

    default:
      return { ok: false, status: 422, message: `unknown selection policy '${candidateSet.selectionPolicy}'` };
  }
}
