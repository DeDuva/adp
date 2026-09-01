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
  // #199: set by the ingest route when `payload` above is the structural
  // projection of what the producer sent rather than what it sent — sha256 of
  // the canonical JSON of the payload as supplied. Null on the `full` path,
  // and on an event that carried no payload to project.
  payloadDigest?: string | null;
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
    // #199: present only on an event whose payload is a structural projection.
    payloadDigest?: string | null;
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
        // #199, on the same terms again, and for a sharper reason than either:
        // this digest is the only thing left committing to the content the
        // projection removed. A digest the chain did not cover could be
        // swapped for one matching a payload that was never sent, which would
        // turn "verified, payload not retained" into a claim about nothing.
        ...(event.payloadDigest !== null && event.payloadDigest !== undefined
          ? { payloadDigest: event.payloadDigest }
          : {}),
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
        // #199: null rather than "" when the payload is stored as supplied —
        // `eventHash` keys off "is it set", and an empty string is set.
        payloadDigest: input.payloadDigest ?? null,
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
//
// #152: the same math as `contiguityOf` above, pushed into one aggregate rather
// than run over an array of every counter the session holds. It used to select
// one row per event and map it — bounded memory only in the sense that an
// integer is smaller than a payload, which stops being reassuring at the
// multi-hour sessions ambient capture produces. `row_number()` reproduces the
// `seq !== i + 1` test exactly: the counters are ascending and distinct (the
// unique partial index in schema.ts), so the smallest position whose value
// disagrees with its position is the first number the emitter never delivered.
// `contiguityOf` stays as the statement of that math, and
// `test/e2e-verify-coverage.test.ts` asserts the two agree on real rows rather
// than leaving the equivalence as a claim in this comment.
export async function emitterContiguity(db: Db, sessionId: string): Promise<EmitterContiguity> {
  const result = await db.execute(sql`
    select
      count(*)::int as n,
      max(producer_seq)::bigint as max_seq,
      min(case when producer_seq <> rn then rn end)::bigint as first_gap
    from (
      select producer_seq, row_number() over (order by producer_seq) as rn
      from session_events
      where session_id = ${sessionId}::uuid and producer_seq is not null
    ) counted
  `);
  const row = result.rows[0] as { n: number; max_seq: string | number | null; first_gap: string | number | null };

  if (Number(row.n) === 0) return { tracked: false, complete: true, maxSeq: null, firstGap: null };
  const firstGap = row.first_gap === null ? null : Number(row.first_gap);
  return { tracked: true, complete: firstGap === null, maxSeq: Number(row.max_seq), firstGap };
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

// How much of a chain a verification actually recomputed. This is the honest
// third state #152 needed and 3-6 already wanted a name for: "verified" is not
// one claim, and reporting an anchored verification as a plain `ok: true` would
// quietly hand a caller the weaker of the two.
//
//   recomputed — every covered event's hash was re-derived from its own
//                contents. Nothing in the range is taken on trust.
//   attested   — the range was recomputed, and everything before it is vouched
//                for by a *signature* over the head it starts from: a
//                checkpoint's `trajectoryHead`. A prefix rewritten to stay
//                internally consistent still fails, because its head would no
//                longer be the one that was signed.
//   assumed    — the range was recomputed and the prefix was neither. The
//                window starts from whatever the database stores at that point.
//                Useful for walking a long chain in passes; not a claim about
//                anything outside the window.
export type ChainPrefix = "recomputed" | "attested" | "assumed";

// The stored hash at one seq, for a caller starting a range there. Named apart
// from `chainHead` because what it returns is *stored* rather than verified —
// which is the whole content of the "assumed" prefix above.
export async function chainHeadAt(db: Db, sessionId: string, seq: number): Promise<string | undefined> {
  const [row] = await db
    .select({ hash: sessionEvents.hash })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.seq, seq)));
  return row?.hash;
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
  // #152: the range this verification covers, so a result can never be read as
  // a claim about more of the chain than was looked at. `verifiedFromSeq` is
  // exclusive and 0 means the genesis; `verifiedToSeq` is inclusive.
  verifiedFromSeq: number;
  verifiedToSeq: number;
  prefix: ChainPrefix;
  // How many signed chain heads the recomputation passed through and agreed
  // with. See `VerifyOptions.attested` for why this is not decoration.
  attestedHeadsChecked: number;
  // #161: events in the verified range whose payload ADP no longer holds, so
  // their hash was taken as recorded rather than re-derived from their
  // contents. This is the third verification state PLAN.md 3-6 wanted a name
  // for, and it is reported as a count rather than folded into `ok` because it
  // is not a failure — it is a different, weaker claim about part of the range,
  // and a reader has to be able to see which part.
  //
  // What it costs, precisely: for those events the typed columns are no longer
  // independently verifiable either, because the hash that covers them cannot
  // be recomputed without the payload it also covers. What survives is the
  // link — the stored hash is what the next event chains to — and any signed
  // head past them still pins the prefix, so a wholesale rewrite is still
  // caught. That is the strongest guarantee available once a preimage is gone,
  // and pretending otherwise would be worse than saying it.
  notRetained: number;
}

// One signed statement about where a chain had reached: a checkpoint's
// `eventCount` and the `trajectoryHead` its envelope commits to.
export interface AttestedHead {
  seq: number;
  hash: string;
}

export interface VerifyOptions {
  // Start after this seq rather than at the genesis. Requires `fromHash`: a
  // starting point without the hash it is supposed to link to would verify a
  // suffix against itself, which is the "verifier that starts too late"
  // failure — internally consistent and blind to everything before it.
  fromSeq?: number;
  // The hash the event at `fromSeq` must carry. Pass a *signed* value — a
  // checkpoint's `trajectoryHead` — and the prefix becomes attested rather
  // than merely assumed; that is the whole difference between the two states
  // of `ChainPrefix`.
  fromHash?: string;
  // Stop after this seq. Lets a caller walk a long session in pieces.
  toSeq?: number;
  // What `fromHash` is worth. Defaults to the weaker of the two, so a caller
  // that skips a prefix without saying where the hash came from gets the answer
  // that claims less — the direction a default in a verifier has to fall.
  prefix?: Exclude<ChainPrefix, "recomputed">;
  // Signed heads to check the recomputation against as it passes them,
  // ascending by seq.
  //
  // Recomputing a chain from its genesis does *not* on its own detect an edit
  // that was made consistently: rewrite an event and repair every hash after
  // it, and the result is a chain that verifies perfectly, because the genesis
  // is derived from the session id and nothing else pins the middle. What pins
  // it is a signature over a head the rewrite would have had to change, and the
  // checkpoints already hold exactly that. Passing them here is what makes a
  // full verification detect the repaired edit as well as the careless one.
  attested?: AttestedHead[];
  // Rows held in memory at once. The knob exists so the tests can prove the
  // batch boundary is not load-bearing by running the same chain at 1, 2 and
  // 7 rows per read and getting one answer.
  batchSize?: number;
}

// How many events one read pulls back. Peak memory for a verification is this
// many rows plus their payloads — a constant, where it used to be the session.
// 500 is the same order as `listEvents`' own default page, so the largest
// object this module allocates is not made larger by verification.
export const VERIFY_BATCH_SIZE = 500;

// Recomputes a session's chain from the stored rows.
//
// This exists because tamper-evidence that nobody can check is decoration. It
// re-derives every hash from the row's own contents rather than trusting the
// stored `hash`, so an edit to any covered column — payload or projection —
// shows up here.
//
// #152: it reads in batches and keeps only the batch. It used to select the
// whole session and iterate the array, so peak memory was the trajectory —
// fine while the worst case was a fixture, and a way to exhaust the server
// with a `repo:read` token once ambient capture (#149) started writing real
// multi-hour sessions.
export async function verifyChain(
  db: Db,
  sessionId: string,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const fromSeq = options.fromSeq ?? 0;
  const batchSize = options.batchSize ?? VERIFY_BATCH_SIZE;
  const anchored = fromSeq > 0;
  const prefix: ChainPrefix = anchored ? (options.prefix ?? "assumed") : "recomputed";

  // The session's true length, read off the tail rather than counted. The chain
  // is contiguous by construction, so `max(seq)` *is* the event count — and it
  // is the number `runChains` and the run attestation already use, which is
  // what keeps an anchored verification able to reproduce a trajectory digest
  // without reading the events the digest covers.
  const { count } = await chainHead(db, sessionId);
  const toSeq = Math.min(options.toSeq ?? count, count);

  // Only the heads inside the range being recomputed can be checked; one at or
  // before `fromSeq` is behind the window, and one past `toSeq` was never
  // reached.
  const attested = (options.attested ?? [])
    .filter((a) => a.seq > fromSeq)
    .sort((a, b) => a.seq - b.seq);
  let attestedIndex = 0;
  let attestedHeadsChecked = 0;
  let notRetained = 0;

  const fail = (brokeAtSeq: number, head: string, reason: string): VerifyResult => ({
    sessionId,
    ok: false,
    count,
    head,
    brokeAtSeq,
    reason,
    verifiedFromSeq: fromSeq,
    verifiedToSeq: brokeAtSeq - 1,
    prefix,
    attestedHeadsChecked,
    notRetained,
  });

  let prevHash = options.fromHash ?? chainGenesis(sessionId);

  if (anchored) {
    if (options.fromHash === undefined) {
      throw new TypeError("verifyChain: fromSeq requires fromHash — see VerifyOptions");
    }
    // The anchor check, and the reason an anchored verification is worth more
    // than a suffix scan. The event at `fromSeq` must carry the hash the
    // signature commits to, so a prefix that was rewritten to stay internally
    // consistent still fails here — its recomputed head no longer matches what
    // was signed.
    //
    // It also catches the one tamper full verification cannot: a chain
    // truncated at the tail verifies perfectly, because what is gone leaves
    // nothing behind to disagree with. A signed anchor beyond the last stored
    // event is the missing evidence.
    const [boundary] = await db
      .select({ seq: sessionEvents.seq, hash: sessionEvents.hash })
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.seq, fromSeq)));
    if (!boundary) {
      return fail(
        fromSeq,
        prevHash,
        prefix === "attested"
          ? `event ${fromSeq} is attested but absent — the chain is shorter than what was signed`
          : `event ${fromSeq} is absent — the chain is shorter than the range asked about`,
      );
    }
    if (boundary.hash !== options.fromHash) {
      const source = prefix === "attested" ? "was signed for it" : "was expected";
      return fail(
        fromSeq,
        prevHash,
        `event ${fromSeq} holds ${boundary.hash.slice(0, 12)}…, but ${options.fromHash.slice(0, 12)}… ${source}`,
      );
    }
  }

  // The signed-head check, shared by both paths through the loop. `prevHash` is
  // the head as of `seq` — recomputed on an ordinary event, taken as stored on
  // one whose payload was aged out — which is precisely what a checkpoint at
  // that event count committed to. Reaching a signed head still pins a reduced
  // region, which is the whole reason retention can drop payloads without
  // dropping tamper-evidence.
  const checkAttested = (seq: number): VerifyResult | null => {
    while (attestedIndex < attested.length && attested[attestedIndex]!.seq === seq) {
      const head = attested[attestedIndex]!;
      if (head.hash !== prevHash) {
        return fail(
          seq,
          prevHash,
          `event ${seq} recomputes to ${prevHash.slice(0, 12)}…, but ${head.hash.slice(0, 12)}… was signed for it — ` +
            "the chain was rewritten after it was attested",
        );
      }
      attestedHeadsChecked++;
      attestedIndex++;
    }
    while (attestedIndex < attested.length && attested[attestedIndex]!.seq < seq) attestedIndex++;
    return null;
  };

  let expectedSeq = fromSeq + 1;
  let cursor = fromSeq;

  while (cursor < toSeq) {
    const rows = await db
      .select()
      .from(sessionEvents)
      .where(
        and(
          eq(sessionEvents.sessionId, sessionId),
          sql`${sessionEvents.seq} > ${cursor}`,
          sql`${sessionEvents.seq} <= ${toSeq}`,
        ),
      )
      .orderBy(asc(sessionEvents.seq))
      .limit(batchSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      if (row.seq !== expectedSeq) {
        return fail(row.seq, prevHash, `sequence gap: expected seq ${expectedSeq}, found ${row.seq}`);
      }
      if (row.prevHash !== prevHash) {
        return fail(
          row.seq,
          prevHash,
          `event ${row.seq} links to ${row.prevHash.slice(0, 12)}…, expected ${prevHash.slice(0, 12)}…`,
        );
      }
      // #161: an event whose payload was aged out cannot be re-derived — the
      // hash covers the payload, and the payload is gone. Its stored hash is
      // taken as the link and counted, rather than recomputed against contents
      // that are no longer all there. Recomputing anyway would compare against
      // a null payload and report every reduced event as tampered, which is the
      // failure mode that makes retention and verification look incompatible
      // when they are not.
      if (!row.payloadRetained) {
        notRetained++;
        prevHash = row.hash;
        expectedSeq++;
        const reducedMismatch = checkAttested(row.seq);
        if (reducedMismatch) return reducedMismatch;
        continue;
      }

      const recomputed = eventHash(sessionId, prevHash, row);
      if (recomputed !== row.hash) {
        return fail(
          row.seq,
          prevHash,
          `event ${row.seq} does not match its recorded hash — contents changed after it was appended`,
        );
      }
      prevHash = recomputed;
      expectedSeq++;
      const mismatch = checkAttested(row.seq);
      if (mismatch) return mismatch;
    }
    cursor = rows[rows.length - 1]!.seq;
  }

  // A range that ended early is a gap at the far end: the tail was deleted
  // after the read that measured it, or `toSeq` names an event that is not
  // there. Either way the caller asked about a range this session cannot
  // answer for, and reporting `ok` would answer for it anyway.
  if (cursor < toSeq) {
    return fail(expectedSeq, prevHash, `sequence gap: expected seq ${expectedSeq}, found end of chain`);
  }

  // A signed head naming an event the chain does not reach is the truncation
  // case from the other side: the events are gone, so nothing was left to
  // disagree with the signature, and a chain that simply stops early otherwise
  // verifies perfectly. Deleting the tail would be the one edit that leaves no
  // trace. Checked only when the range ran to the end of the chain — a caller
  // who asked for a window that stops early has claimed nothing about what
  // follows it.
  const unreached = toSeq === count ? attested.find((a) => a.seq > count) : undefined;
  if (unreached) {
    return {
      sessionId,
      ok: false,
      count,
      head: prevHash,
      brokeAtSeq: unreached.seq,
      reason: `event ${unreached.seq} is attested but the chain ends at ${count} — events were removed after they were attested`,
      verifiedFromSeq: fromSeq,
      verifiedToSeq: toSeq,
      prefix,
      attestedHeadsChecked,
      notRetained,
    };
  }

  return {
    sessionId,
    ok: true,
    count,
    head: prevHash,
    brokeAtSeq: null,
    reason: null,
    verifiedFromSeq: fromSeq,
    verifiedToSeq: toSeq,
    prefix,
    attestedHeadsChecked,
    notRetained,
  };
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
    // #199: null means the payload above is exactly what the producer sent.
    // Non-null means it is that payload's shape with the string content
    // removed, and this is sha256 of the canonical JSON of what was sent — so
    // a reader can tell the two apart, and a producer holding its own copy can
    // prove the record corresponds to it.
    payload_digest: row.payloadDigest,
    occurred_at: row.occurredAt.toISOString(),
    hash: row.hash,
    prev_hash: row.prevHash,
    created_at: row.createdAt.toISOString(),
  };
}
