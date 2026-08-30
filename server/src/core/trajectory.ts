import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessionEvents, sessions } from "../db/schema.js";
import { canonicalJson } from "./canonical.js";

export type SessionEventRow = typeof sessionEvents.$inferSelect;

export const EVENT_KINDS = [
  "message",
  "model_call",
  "tool_call",
  "handoff",
  "commit",
  "test_result",
  "custom",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_STATUSES = ["success", "failure", "error", "rejected", "skipped"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export interface EventInput {
  kind: EventKind;
  type?: string;
  payload: unknown;
  status?: EventStatus | null;
  model?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costMicroUsd?: number | null;
  durationMs?: number | null;
  gitSha?: string | null;
  relatedSessionId?: string | null;
  clientEventId?: string | null;
  // The emitter's own contiguous counter (see schema.ts). Optional, but
  // all-or-nothing within a batch.
  producerSeq?: number | null;
  // #148: set by the ingest route from the secret detector, never by a
  // producer. It travels with the event so the chain commits to it, and it is
  // absent — not empty — on the ordinary event nothing fired on.
  redactions?: { path: string; pattern: string }[] | null;
  occurredAt?: Date;
}

export interface TrajectoryError {
  ok: false;
  status: 404 | 409 | 422;
  message: string;
  // Set on a contiguity rejection: the producer_seq this session is waiting
  // for. An emitter replaying from its spool needs to know where to resume,
  // and making it guess is how a gap becomes a duplicate.
  expectedNextSeq?: number;
}

// The chain's genesis. Binding it to the session id means an event sequence
// cannot be lifted wholesale out of one session and replayed into another: the
// first hash would not match, and every hash after it inherits that.
export function chainGenesis(sessionId: string): string {
  return createHash("sha256").update(`adp/trajectory/v1/${sessionId}`, "utf8").digest("hex");
}

// What each event commits to. Every column that a reader might act on is in
// here — not just `payload` — so the typed projection columns cannot be edited
// out from under the chain that vouches for them.
//
// `producerSeq`/`producerId` are included **only when set**, keys omitted
// entirely otherwise. That is not a style choice: every row written before
// those columns existed has them null, and adding them as explicit nulls would
// change what those rows hash to, so `verifyChain` would report the whole
// corpus as tampered. Omission keeps old rows hashing exactly as they did while
// new rows still commit to the counter that proves nothing was dropped — which
// is also why `v` stays 1. It is one hash function, not two.
export function eventHash(
  sessionId: string,
  prevHash: string,
  event: {
    seq: number;
    kind: string;
    type: string;
    payload: unknown;
    status: string | null;
    model: string | null;
    tokensIn: number | null;
    tokensOut: number | null;
    costMicroUsd: number | null;
    durationMs: number | null;
    gitSha: string | null;
    relatedSessionId: string | null;
    producerSeq?: number | null;
    producerId?: string | null;
    // #148: present only on an event the secret detector actually touched.
    redactions?: unknown;
    occurredAt: Date;
  },
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        v: 1,
        sessionId,
        prev: prevHash,
        seq: event.seq,
        kind: event.kind,
        type: event.type,
        payload: event.payload ?? null,
        status: event.status ?? null,
        model: event.model ?? null,
        tokensIn: event.tokensIn ?? null,
        tokensOut: event.tokensOut ?? null,
        costMicroUsd: event.costMicroUsd ?? null,
        durationMs: event.durationMs ?? null,
        gitSha: event.gitSha ?? null,
        relatedSessionId: event.relatedSessionId ?? null,
        ...(event.producerSeq !== null && event.producerSeq !== undefined
          ? { producerSeq: event.producerSeq }
          : {}),
        ...(event.producerId !== null && event.producerId !== undefined ? { producerId: event.producerId } : {}),
        // #148, on exactly the terms `producerSeq` set above: the key is
        // omitted entirely when nothing was redacted, so every event written
        // before this column existed hashes to what it always did. Included
        // when it is set, because a redaction that the chain did not commit to
        // could be edited away afterwards — and the whole point of recording
        // one is that it survives.
        ...(event.redactions !== null && event.redactions !== undefined ? { redactions: event.redactions } : {}),
        occurredAt: event.occurredAt.toISOString(),
      }),
      "utf8",
    )
    .digest("hex");
}

export interface AppendResult {
  ok: true;
  appended: SessionEventRow[];
  // Ids that were already present and therefore skipped. Reported rather than
  // silently absorbed: an emitter that keeps re-sending the same batch has a
  // bug, and hiding the retry hides the bug.
  duplicates: string[];
  head: string;
  count: number;
  // The highest producer_seq this session has durably stored, or null if the
  // session is untracked. An emitter trims its spool up to this mark, so it is
  // the acknowledgement half of the completeness guarantee.
  acceptedThrough: number | null;
}

export interface AppendOptions {
  // Who is counting. Batch-level rather than per-event because a chain has one
  // writer — see the unique index in schema.ts.
  producerId?: string | null;
}

// Appends a batch to one session's trajectory.
//
// Serialized on the session row for the same reason checkpoint sequencing is
// (core/sessions.ts): `seq` and the chain head are both read-modify-write, and
// two concurrent batches without the lock would either collide on the unique
// index — surfacing as an unhandled 23505, i.e. a 500 — or interleave into a
// chain that no longer verifies.
export async function appendEvents(
  db: Db,
  repoId: string,
  sessionId: string,
  events: EventInput[],
  options: AppendOptions = {},
  now: () => Date = () => new Date(),
): Promise<AppendResult | TrajectoryError> {
  // All-or-nothing within a batch. A half-counted batch would leave the
  // emitter's own numbering with a hole it could never explain, which defeats
  // the point of counting.
  const counted = events.filter((e) => e.producerSeq !== null && e.producerSeq !== undefined).length;
  if (counted > 0 && counted !== events.length) {
    return {
      ok: false,
      status: 422,
      message: "producer_seq must be set on every event in a batch or on none of them",
    };
  }

  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.repoId, repoId)));
  if (!session) return { ok: false, status: 404, message: "session not found" };
  if (session.status === "closed") {
    return { ok: false, status: 409, message: "cannot append to a closed session" };
  }

  // A handoff naming a session in another repo — or no session at all — would
  // produce an edge that can never be walked. Reject it here rather than
  // discovering it when someone draws the graph.
  const related = events.map((e) => e.relatedSessionId).filter((id): id is string => !!id);
  if (related.length > 0) {
    const found = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.repoId, repoId), inArray(sessions.id, [...new Set(related)])));
    const known = new Set(found.map((r) => r.id));
    const missing = [...new Set(related)].filter((id) => !known.has(id));
    if (missing.length > 0) {
      return {
        ok: false,
        status: 422,
        message: `related_session_id not found in this repository: ${missing.join(", ")}`,
      };
    }
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from sessions where id = ${sessionId} for update`);

    const [tail] = await tx
      .select({ seq: sessionEvents.seq, hash: sessionEvents.hash })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId))
      .orderBy(sql`${sessionEvents.seq} desc`)
      .limit(1);

    // Read the column rather than `max(...)`: pg hands a bigint back as a
    // string, and a raw aggregate would arrive as one — `"2" + 1` is `"21"`,
    // which is the kind of bug that only shows up as a nonsense error message
    // to whoever is trying to replay. Selecting the column lets drizzle's
    // bigint mapping do it, and the unique index serves the ordering.
    const [producerTail] = await tx
      .select({ producerSeq: sessionEvents.producerSeq })
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), sql`${sessionEvents.producerSeq} is not null`))
      .orderBy(sql`${sessionEvents.producerSeq} desc`)
      .limit(1);
    const maxProducerSeq = producerTail?.producerSeq ?? null;

    // Deduplicate *before* chaining. Dropping a duplicate afterwards would leave
    // a gap in `seq`; dropping it first means a retried batch produces exactly
    // the chain the first attempt did.
    const candidateIds = events.map((e) => e.clientEventId).filter((id): id is string => !!id);
    const seen = new Set<string>();
    if (candidateIds.length > 0) {
      const existing = await tx
        .select({ clientEventId: sessionEvents.clientEventId })
        .from(sessionEvents)
        .where(
          and(eq(sessionEvents.sessionId, sessionId), inArray(sessionEvents.clientEventId, [...new Set(candidateIds)])),
        );
      for (const row of existing) if (row.clientEventId) seen.add(row.clientEventId);
    }

    const duplicates: string[] = [];
    const fresh: EventInput[] = [];
    for (const input of events) {
      if (input.clientEventId) {
        // Also catches a batch that repeats an id within itself, which is the
        // shape a retry-with-append bug actually takes.
        if (seen.has(input.clientEventId)) {
          duplicates.push(input.clientEventId);
          continue;
        }
        seen.add(input.clientEventId);
      }
      fresh.push(input);
    }

    // Contiguity, checked on what survived dedup — a replayed batch whose
    // events already landed is not a gap. `client_event_id` proves a retry did
    // no harm; this proves nothing went missing in between, which is the claim
    // "the recorder recorded everything" actually rests on.
    const tracked = fresh.filter((e) => e.producerSeq !== null && e.producerSeq !== undefined);
    if (tracked.length > 0) {
      const expected = (maxProducerSeq ?? 0) + 1;
      for (const [i, input] of tracked.entries()) {
        if (input.producerSeq !== expected + i) {
          return {
            ok: false as const,
            status: 409 as const,
            message:
              `producer_seq ${input.producerSeq} is not contiguous: this session expects ${expected + i}. ` +
              `Replay from ${expected}.`,
            expectedNextSeq: expected,
          };
        }
      }
    }

    let prevHash = tail?.hash ?? chainGenesis(sessionId);
    let seq = tail?.seq ?? 0;
    let acceptedThrough = maxProducerSeq;
    const values: (typeof sessionEvents.$inferInsert)[] = [];

    for (const input of fresh) {
      seq += 1;
      const producerSeq = input.producerSeq ?? null;
      const row = {
        sessionId,
        seq,
        kind: input.kind,
        type: input.type ?? "",
        // `{}` rather than null. The endpoint declares `required: [kind]`, so an
        // event with only a kind is a legal request; sending an explicit null
        // here made it a 500 on the not-null constraint, and a column default
        // cannot save it because Postgres only defaults a column that is
        // *omitted*, not one given null. See issue #63.
        //
        // Safe for the chain: this value is what `eventHash` commits to below,
        // so a payload-less event hashes over `{}` and verifies over the `{}`
        // that was stored. No existing row is affected — the not-null
        // constraint means none of them has a null payload to re-hash.
        payload: (input.payload ?? {}) as object,
        // Null rather than [] when nothing fired: `eventHash` keys off "is it
        // set", and an empty array is set.
        redactions: input.redactions && input.redactions.length > 0 ? input.redactions : null,
        status: input.status ?? null,
        model: input.model ?? null,
        tokensIn: input.tokensIn ?? null,
        tokensOut: input.tokensOut ?? null,
        costMicroUsd: input.costMicroUsd ?? null,
        durationMs: input.durationMs ?? null,
        gitSha: input.gitSha ?? null,
        relatedSessionId: input.relatedSessionId ?? null,
        clientEventId: input.clientEventId ?? null,
        producerSeq,
        producerId: producerSeq === null ? null : (options.producerId ?? null),
        occurredAt: input.occurredAt ?? now(),
      };
      const hash = eventHash(sessionId, prevHash, row);
      values.push({ ...row, prevHash, hash });
      prevHash = hash;
      if (producerSeq !== null) acceptedThrough = Math.max(acceptedThrough ?? 0, producerSeq);
    }

    const appended = values.length > 0 ? await tx.insert(sessionEvents).values(values).returning() : [];

    if (appended.length > 0) {
      await tx.update(sessions).set({ updatedAt: new Date() }).where(eq(sessions.id, sessionId));
    }

    return { ok: true as const, appended, duplicates, head: prevHash, count: seq, acceptedThrough };
  });
}

export interface EmitterContiguity {
  // Whether this session's emitter counts at all. A session with no producer
  // seqs is untracked, which is a different statement from incomplete — an
  // emitter that never claimed completeness has not failed to deliver it.
  tracked: boolean;
  complete: boolean;
  maxSeq: number | null;
  // The first number the emitter never delivered, so the answer is actionable
  // rather than "something is missing".
  firstGap: number | null;
}

// The math, over an ascending list of the producer seqs a session holds.
// Complete means 1..max with nothing skipped: a run that starts at 2 lost its
// first event just as surely as one missing its fifth, so the count is checked
// against the numbering rather than against itself.
export function contiguityOf(seqs: number[]): EmitterContiguity {
  if (seqs.length === 0) return { tracked: false, complete: true, maxSeq: null, firstGap: null };
  const maxSeq = seqs[seqs.length - 1]!;
  for (const [i, seq] of seqs.entries()) {
    if (seq !== i + 1) return { tracked: true, complete: false, maxSeq, firstGap: i + 1 };
  }
  return { tracked: true, complete: true, maxSeq, firstGap: null };
}

// Whether the emitter's own numbering arrived whole. The hash chain proves the
// events ADP holds have not been edited; this proves ADP was given all of them.
export async function emitterContiguity(db: Db, sessionId: string): Promise<EmitterContiguity> {
  const rows = await db
    .select({ producerSeq: sessionEvents.producerSeq })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.sessionId, sessionId), sql`${sessionEvents.producerSeq} is not null`))
    .orderBy(asc(sessionEvents.producerSeq));

  return contiguityOf(rows.map((r) => r.producerSeq!));
}

export interface ChainSummary {
  sessionId: string;
  count: number;
  head: string;
}

// The head of a session's chain, without reading the events themselves — the
// value checkpoints and run attestations commit to.
export async function chainHead(db: Db, sessionId: string): Promise<ChainSummary> {
  const [tail] = await db
    .select({ seq: sessionEvents.seq, hash: sessionEvents.hash })
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId))
    .orderBy(sql`${sessionEvents.seq} desc`)
    .limit(1);
  return { sessionId, count: tail?.seq ?? 0, head: tail?.hash ?? chainGenesis(sessionId) };
}

export interface VerifyResult {
  sessionId: string;
  ok: boolean;
  count: number;
  head: string;
  // Where it first went wrong, or null. The seq matters: "the chain is broken"
  // is not actionable, "event 4108 does not match its recorded hash" is.
  brokeAtSeq: number | null;
  reason: string | null;
}

// Recomputes a session's chain from the stored rows.
//
// This exists because tamper-evidence that nobody can check is decoration. It
// re-derives every hash from the row's own contents rather than trusting the
// stored `hash`, so an edit to any covered column — payload or projection —
// shows up here.
export async function verifyChain(db: Db, sessionId: string): Promise<VerifyResult> {
  const rows = await db
    .select()
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId))
    .orderBy(asc(sessionEvents.seq));

  let prevHash = chainGenesis(sessionId);
  for (const [i, row] of rows.entries()) {
    if (row.seq !== i + 1) {
      return {
        sessionId,
        ok: false,
        count: rows.length,
        head: prevHash,
        brokeAtSeq: row.seq,
        reason: `sequence gap: expected seq ${i + 1}, found ${row.seq}`,
      };
    }
    if (row.prevHash !== prevHash) {
      return {
        sessionId,
        ok: false,
        count: rows.length,
        head: prevHash,
        brokeAtSeq: row.seq,
        reason: `event ${row.seq} links to ${row.prevHash.slice(0, 12)}…, expected ${prevHash.slice(0, 12)}…`,
      };
    }
    const recomputed = eventHash(sessionId, prevHash, row);
    if (recomputed !== row.hash) {
      return {
        sessionId,
        ok: false,
        count: rows.length,
        head: prevHash,
        brokeAtSeq: row.seq,
        reason: `event ${row.seq} does not match its recorded hash — contents changed after it was appended`,
      };
    }
    prevHash = recomputed;
  }

  return { sessionId, ok: true, count: rows.length, head: prevHash, brokeAtSeq: null, reason: null };
}

export interface ListEventsOptions {
  kinds?: EventKind[];
  since?: number;
  limit?: number;
}

export async function listEvents(
  db: Db,
  sessionId: string,
  options: ListEventsOptions = {},
): Promise<SessionEventRow[]> {
  const filters = [eq(sessionEvents.sessionId, sessionId)];
  if (options.kinds && options.kinds.length > 0) filters.push(inArray(sessionEvents.kind, options.kinds));
  if (options.since !== undefined) filters.push(sql`${sessionEvents.seq} > ${options.since}`);
  return db
    .select()
    .from(sessionEvents)
    .where(and(...filters))
    .orderBy(asc(sessionEvents.seq))
    .limit(Math.min(options.limit ?? 500, 2000));
}

export function serializeEvent(row: SessionEventRow) {
  return {
    id: row.id,
    session_id: row.sessionId,
    seq: row.seq,
    kind: row.kind,
    type: row.type,
    payload: row.payload,
    status: row.status,
    model: row.model,
    tokens_in: row.tokensIn,
    tokens_out: row.tokensOut,
    cost_micro_usd: row.costMicroUsd,
    duration_ms: row.durationMs,
    git_sha: row.gitSha,
    related_session_id: row.relatedSessionId,
    client_event_id: row.clientEventId,
    producer_seq: row.producerSeq,
    producer_id: row.producerId,
    // #148: null on an event nothing fired on, which is most of them. Surfaced
    // rather than kept server-side because a reader looking at a trajectory
    // needs to know the difference between "the agent never saw a secret" and
    // "the agent saw one and this is what is left of it".
    redactions: row.redactions,
    occurred_at: row.occurredAt.toISOString(),
    hash: row.hash,
    prev_hash: row.prevHash,
    created_at: row.createdAt.toISOString(),
  };
}
