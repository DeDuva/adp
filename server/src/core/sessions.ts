import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "./git-backend.js";
import type { Signer } from "./signing.js";
import { sessions, checkpoints, workspaces, intents, operations, runs, sessionEvents } from "../db/schema.js";
import { recordOperation } from "./operations.js";
import { chainGenesis } from "./trajectory.js";
import { createWorkspace } from "./workspaces.js";
import { signStatement, verifyEnvelope, decodeStatement, type DsseEnvelope, type InTotoStatement } from "./dsse.js";
import { KeyRegistry } from "./signing.js";

export type SessionRow = typeof sessions.$inferSelect;
export type CheckpointRow = typeof checkpoints.$inferSelect;

export const CHECKPOINT_PREDICATE_TYPE = "https://adp.dev/attestations/checkpoint/v1";

export interface SessionError {
  ok: false;
  status: 404 | 409 | 422;
  message: string;
}

// The harness-supplied resume state is opaque to ADP — never parsed, never
// branched on — but it still has to be *covered* by the checkpoint's signature,
// or "one continuous signed history across both harnesses" (D2) would be a
// claim about the git sha alone while the thing a harness actually resumes from
// travelled unauthenticated. Hashing it keeps the statement small and keeps
// arbitrarily large harness state out of the signed payload.
export function hashState(state: unknown): string {
  return createHash("sha256").update(JSON.stringify(state ?? null), "utf8").digest("hex");
}

export function checkpointStatement(
  publicUrl: string,
  repo: { owner: string; name: string },
  session: { id: string },
  checkpoint: {
    seq: number;
    gitSha: string;
    harness: string;
    state: unknown;
    // The session's trajectory chain head at checkpoint time. Session events are
    // hash-chained rather than individually signed (core/trajectory.ts) because
    // signing thousands of them per run would price recording out of the hot
    // path; this is where that chain becomes signed evidence. A checkpoint now
    // attests to *what the agent did* up to this point, not only to which commit
    // it reached — and a resume that verifies the checkpoint has, transitively,
    // verified the trajectory behind it.
    trajectoryHead: string;
    eventCount: number;
  },
): InTotoStatement {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `git+${publicUrl}/${repo.owner}/${repo.name}`, digest: { sha1: checkpoint.gitSha } }],
    predicateType: CHECKPOINT_PREDICATE_TYPE,
    predicate: {
      sessionId: session.id,
      seq: checkpoint.seq,
      harness: checkpoint.harness,
      stateSha256: hashState(checkpoint.state),
      trajectoryHead: checkpoint.trajectoryHead,
      eventCount: checkpoint.eventCount,
    },
  };
}

export async function startSession(
  db: Db,
  repo: { id: string; owner: string; name: string },
  input: { harness: string; intentId?: string | null; workspaceId?: string | null; runId?: string | null },
  actorId: string,
): Promise<{ ok: true; session: SessionRow } | SessionError> {
  let runIntentId: string | null = null;
  if (input.runId) {
    const [run] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.id, input.runId), eq(runs.repoId, repo.id)));
    if (!run) return { ok: false, status: 422, message: `run ${input.runId} not found in this repository` };
    // A session joining a closed run would append trajectory the run's signed
    // attestation does not cover, which is exactly the state that makes an
    // attestation misleading rather than absent.
    if (run.status !== "open") {
      return { ok: false, status: 409, message: `run ${input.runId} is ${run.status}` };
    }
    runIntentId = run.intentId;
    // The run already states the intent; inheriting it means the common case
    // needs one field, and disagreement is caught instead of silently kept.
    if (input.intentId && input.intentId !== run.intentId) {
      return {
        ok: false,
        status: 422,
        message: `intent ${input.intentId} does not match run ${input.runId}'s intent ${run.intentId}`,
      };
    }
  }
  if (input.intentId) {
    const [intent] = await db
      .select()
      .from(intents)
      .where(and(eq(intents.id, input.intentId), eq(intents.repoId, repo.id)));
    if (!intent) return { ok: false, status: 422, message: `intent ${input.intentId} not found in this repository` };
  }
  if (input.workspaceId) {
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.repoId, repo.id)));
    if (!workspace) {
      return { ok: false, status: 422, message: `workspace ${input.workspaceId} not found in this repository` };
    }
  }

  const session = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(sessions)
      .values({
        repoId: repo.id,
        intentId: input.intentId ?? runIntentId,
        runId: input.runId ?? null,
        harness: input.harness,
        actorId,
        workspaceId: input.workspaceId ?? null,
      })
      .returning();

    await recordOperation(tx, {
      repoId: repo.id,
      actorId,
      verb: "session.start",
      target: `${repo.owner}/${repo.name}@session:${row!.id}`,
      after: {
        id: row!.id,
        harness: input.harness,
        intentId: input.intentId ?? runIntentId,
        runId: input.runId ?? null,
      },
    });

    return row!;
  });

  return { ok: true, session };
}

export async function createCheckpoint(
  db: Db,
  gitBackend: GitBackend,
  signer: Signer,
  publicUrl: string,
  repo: { id: string; owner: string; name: string },
  sessionId: string,
  input: { gitSha: string; harness?: string; state: unknown },
  actorId: string,
): Promise<{ ok: true; checkpoint: CheckpointRow } | SessionError> {
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.repoId, repo.id)));
  if (!session) return { ok: false, status: 404, message: "session not found" };
  if (session.status === "closed") {
    return { ok: false, status: 409, message: "cannot checkpoint a closed session" };
  }

  // A checkpoint naming a commit this repo doesn't have is not resumable, and
  // resume time — possibly in a different harness, hours later — is the worst
  // place to discover that. Reject it at write time instead.
  if (!(await gitBackend.statPath(repo.owner, repo.name, input.gitSha, ""))) {
    return { ok: false, status: 422, message: `commit '${input.gitSha}' could not be resolved in this repository` };
  }

  const checkpoint = await db.transaction(async (tx) => {
    // Lock the session row first, so concurrent checkpoints against one session
    // serialize here rather than racing on max(seq) — the same pattern issue
    // and proposal numbering use (http-gql/resolvers.ts). Without it, two
    // harnesses checkpointing at once both compute the same `seq` and the
    // unique index turns the loser into an unhandled 23505, which is a 500
    // where the caller deserves either a checkpoint or a typed error.
    await tx.execute(sql`select id from sessions where id = ${sessionId} for update`);

    const [seqRow] = await tx
      .select({ nextSeq: sql<number>`coalesce(max(${checkpoints.seq}), 0) + 1` })
      .from(checkpoints)
      .where(eq(checkpoints.sessionId, sessionId));
    const nextSeq = seqRow!.nextSeq;

    // Read the chain head inside the same lock that serializes `seq`, so the
    // head the checkpoint signs is the head as of this checkpoint and not one a
    // concurrent append moved underneath it.
    const [tail] = await tx
      .select({ seq: sessionEvents.seq, hash: sessionEvents.hash })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId))
      .orderBy(sql`${sessionEvents.seq} desc`)
      .limit(1);

    const harness = input.harness ?? session.harness;
    const envelope = signStatement(
      signer,
      checkpointStatement(publicUrl, repo, session, {
        seq: nextSeq,
        gitSha: input.gitSha,
        harness,
        state: input.state,
        trajectoryHead: tail?.hash ?? chainGenesis(sessionId),
        eventCount: tail?.seq ?? 0,
      }),
    );

    const [row] = await tx
      .insert(checkpoints)
      .values({
        sessionId,
        seq: nextSeq,
        gitSha: input.gitSha,
        harness,
        state: input.state as object,
        envelope,
      })
      .returning();

    await tx.update(sessions).set({ updatedAt: new Date() }).where(eq(sessions.id, sessionId));

    await recordOperation(tx, {
      repoId: repo.id,
      actorId,
      verb: "session.checkpoint",
      target: `${repo.owner}/${repo.name}@session:${sessionId}`,
      after: { checkpointId: row!.id, seq: row!.seq, gitSha: row!.gitSha, harness },
    });

    return row!;
  });

  return { ok: true, checkpoint };
}

export interface ResumeResult {
  ok: true;
  session: SessionRow;
  previousSessionId: string;
  checkpoint: CheckpointRow;
  workspace: typeof workspaces.$inferSelect;
}

// D2, stated precisely: resuming checkpoint `c` of session `s` under harness
// `h'` creates a *new* session linked by `resumedFromSessionId`, forks a
// workspace at `c.gitSha`, marks `s` resumed, and records `session.resume` with
// `parentOp` pointing at `c`'s own `session.checkpoint` operation — so the op
// log alone reconstructs the chain across harnesses, with no join table.
//
// The old session is never mutated beyond its status: history is append-only,
// and a resume is a new branch of the story rather than an edit to the old one.
export async function resumeSession(
  db: Db,
  gitBackend: GitBackend,
  signer: Signer,
  repo: { id: string; owner: string; name: string; orgId: string | null },
  sessionId: string,
  input: { harness: string; checkpointId?: string },
  actorId: string,
  // #102: resolves the checkpoint envelope's keyid — a checkpoint signed
  // before a key rotation must stay resumable after it. Defaults to the
  // active signer alone for callers that predate registries.
  keyRegistry: KeyRegistry = new KeyRegistry(signer),
): Promise<ResumeResult | SessionError> {
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.repoId, repo.id)));
  if (!session) return { ok: false, status: 404, message: "session not found" };

  const [checkpoint] = input.checkpointId
    ? await db
        .select()
        .from(checkpoints)
        .where(and(eq(checkpoints.id, input.checkpointId), eq(checkpoints.sessionId, sessionId)))
    : await db
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.sessionId, sessionId))
        .orderBy(desc(checkpoints.seq))
        .limit(1);
  if (!checkpoint) {
    return { ok: false, status: 422, message: "session has no checkpoint to resume from" };
  }

  // Verification is not optional. An unverified resume would make "one
  // continuous signed history" false while still looking true from the
  // outside — the whole D2 claim rests on this call.
  if (!verifyEnvelope(keyRegistry, checkpoint.envelope as DsseEnvelope)) {
    return {
      ok: false,
      status: 422,
      message: `checkpoint ${checkpoint.id} failed signature verification — refusing to resume from unverified state`,
    };
  }
  const statement = decodeStatement(checkpoint.envelope as DsseEnvelope);
  const predicate = statement.predicate as { stateSha256?: string };
  if (predicate.stateSha256 !== hashState(checkpoint.state)) {
    return {
      ok: false,
      status: 422,
      message: `checkpoint ${checkpoint.id} state does not match its signed digest — refusing to resume`,
    };
  }

  // Fork the workspace at the checkpointed commit. createWorkspace resolves a
  // ref rather than a sha, so the checkpoint's sha is published under a
  // throwaway ref first — the alternative would be teaching workspaces about
  // shas purely for this path.
  const forkRef = `adp/resume/${checkpoint.id}`;
  await gitBackend.createRef(repo.owner, repo.name, `refs/heads/${forkRef}`, checkpoint.gitSha);
  const created = await createWorkspace(db, gitBackend, repo, forkRef, actorId, undefined);
  await gitBackend.deleteRef(repo.owner, repo.name, `refs/heads/${forkRef}`);
  if (!created.ok) return { ok: false, status: 422, message: created.message };

  // A resume stays in its run only while that run is still open. Attaching a
  // fresh session to a closed run would grow a trajectory the run's signed
  // attestation already fixed the shape of; the resume is still allowed, it just
  // becomes work that outlived the assignment, which is what it is.
  let inheritedRunId: string | null = null;
  if (session.runId) {
    const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, session.runId));
    if (run?.status === "open") inheritedRunId = session.runId;
  }

  const resumed = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(sessions)
      .values({
        repoId: repo.id,
        intentId: session.intentId,
        runId: inheritedRunId,
        harness: input.harness,
        actorId,
        workspaceId: created.workspace.id,
        resumedFromSessionId: session.id,
      })
      .returning();

    await tx
      .update(sessions)
      .set({ status: "resumed", updatedAt: new Date() })
      .where(eq(sessions.id, session.id));

    // parentOp links this resume to the checkpoint operation it resumed from,
    // which is what makes the whole cross-harness chain walkable from the op
    // log alone.
    const [checkpointOp] = await tx
      .select({ id: operations.id })
      .from(operations)
      .where(
        and(
          eq(operations.repoId, repo.id),
          eq(operations.verb, "session.checkpoint"),
          sql`${operations.after} ->> 'checkpointId' = ${checkpoint.id}`,
        ),
      )
      .limit(1);

    await recordOperation(tx, {
      repoId: repo.id,
      actorId,
      verb: "session.resume",
      target: `${repo.owner}/${repo.name}@session:${row!.id}`,
      parentOp: checkpointOp?.id,
      before: { sessionId: session.id, harness: session.harness },
      after: {
        sessionId: row!.id,
        harness: input.harness,
        resumedFromSessionId: session.id,
        checkpointId: checkpoint.id,
        gitSha: checkpoint.gitSha,
        workspaceId: created.workspace.id,
      },
    });

    return row!;
  });

  return {
    ok: true,
    session: resumed,
    previousSessionId: session.id,
    checkpoint,
    workspace: created.workspace,
  };
}

export async function closeSession(
  db: Db,
  repo: { id: string; owner: string; name: string },
  sessionId: string,
  actorId: string,
): Promise<{ ok: true; session: SessionRow } | SessionError> {
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.repoId, repo.id)));
  if (!session) return { ok: false, status: 404, message: "session not found" };
  if (session.status === "closed") return { ok: true, session };

  const closed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(sessions)
      .set({ status: "closed", updatedAt: new Date() })
      .where(eq(sessions.id, sessionId))
      .returning();

    await recordOperation(tx, {
      repoId: repo.id,
      actorId,
      verb: "session.close",
      target: `${repo.owner}/${repo.name}@session:${sessionId}`,
      before: { status: session.status },
      after: { status: "closed" },
    });

    return row!;
  });

  return { ok: true, session: closed };
}

export async function listCheckpoints(db: Db, sessionId: string): Promise<CheckpointRow[]> {
  return db.select().from(checkpoints).where(eq(checkpoints.sessionId, sessionId)).orderBy(checkpoints.seq);
}

// Walks the resume chain back to the session that started it. This is what
// makes a resumed session's whole lineage retrievable without the caller
// knowing how many harnesses it passed through.
export async function sessionLineage(db: Db, repoId: string, sessionId: string): Promise<SessionRow[]> {
  const chain: SessionRow[] = [];
  let cursor: string | null = sessionId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const [row]: SessionRow[] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, cursor), eq(sessions.repoId, repoId)));
    if (!row) break;
    chain.unshift(row);
    cursor = row.resumedFromSessionId;
  }
  return chain;
}
