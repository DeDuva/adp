import type { Db } from "../db/client.js";
import type { KeyRegistry } from "./signing.js";
import { mapWithConcurrency } from "./concurrency.js";
import { verifiedAnchors, type ChainAnchor } from "./sessions.js";
import {
  emitterContiguity,
  verifyChain,
  type EmitterContiguity,
  type VerifyOptions,
  type VerifyResult,
} from "./trajectory.js";

// How much of a chain the caller asked to be recomputed.
//
//   full            — from the genesis. The strong claim, and the default,
//                     because the default has to be the one a caller who reads
//                     only `ok` is entitled to assume.
//   from-checkpoint — from the newest checkpoint whose signature verifies.
//                     Bounded by what has happened since that checkpoint rather
//                     than by the age of the session.
//
// `verifyChain` underneath can verify an arbitrary window, and reports it as
// the third `ChainPrefix` state; nothing over HTTP asks for one yet, so this
// type carries the two coverages a caller can actually request.
export type VerifyCoverage = "full" | "from-checkpoint";

// How many sessions of one run are verified at a time.
//
// #152: this used to be `Promise.all` over every session in the run, so the
// peak cost of a `repo:read` request was the number of sessions times the size
// of the largest — and both are set by whoever wrote the run, not by the
// server. Four is chosen to keep a request meaningfully parallel against
// database latency while making the fan-out a constant. It is a constant rather
// than an env var on purpose: this bounds an attack surface, and a deployment
// that raises it has un-bounded it.
export const VERIFY_SESSION_CONCURRENCY = 4;

export interface SessionVerification {
  chain: VerifyResult;
  emitter: EmitterContiguity;
  // The signed checkpoint the verification started from, or null when it
  // started at the genesis. Reported rather than kept internal: "we skipped the
  // first 40,000 events because this envelope says so" is exactly the claim a
  // reader has to be able to audit.
  anchor: ChainAnchor | null;
}

export interface VerifySessionOptions {
  coverage?: VerifyCoverage;
  batchSize?: number;
}

// Verifies one session's chain and its emitter's numbering.
//
// The two are deliberately separate answers all the way out to the response:
// the chain says the events ADP holds were not edited, the emitter counter says
// ADP was given all of them, and a run can pass the first while failing the
// second.
export async function verifySession(
  db: Db,
  keys: KeyRegistry,
  sessionId: string,
  options: VerifySessionOptions = {},
): Promise<SessionVerification> {
  const coverage = options.coverage ?? "full";
  const anchors = await verifiedAnchors(db, keys, sessionId);
  const latest = anchors.length > 0 ? anchors[anchors.length - 1]! : null;
  let anchor: ChainAnchor | null = null;
  const chainOptions: VerifyOptions = { batchSize: options.batchSize };

  if (coverage === "from-checkpoint" && latest) {
    // No usable anchor falls through to a full verification rather than to an
    // error. Anchoring is an optimisation over a stronger check; failing to
    // find one costs time, never assurance.
    anchor = latest;
    chainOptions.fromSeq = anchor.eventCount;
    chainOptions.fromHash = anchor.head;
    chainOptions.prefix = "attested";
  } else {
    // Full coverage recomputes the chain *and* checks it against every signed
    // head on the way past, which is strictly more than recomputing alone: a
    // rewrite that repairs the hashes behind it produces a chain that
    // recomputes perfectly, and only a signature over a head it would have had
    // to change catches it. That is why `full` stays the default even though
    // `from-checkpoint` is the one with "attested" in its name.
    chainOptions.attested = anchors.map((a) => ({ seq: a.eventCount, hash: a.head }));
  }

  const [chain, emitter] = await Promise.all([
    verifyChain(db, sessionId, chainOptions),
    emitterContiguity(db, sessionId),
  ]);
  return { chain, emitter, anchor };
}

// Verifies a run's sessions with a bounded fan-out. See VERIFY_SESSION_CONCURRENCY.
export async function verifySessions(
  db: Db,
  keys: KeyRegistry,
  sessionIds: readonly string[],
  options: VerifySessionOptions = {},
): Promise<SessionVerification[]> {
  return mapWithConcurrency(sessionIds, VERIFY_SESSION_CONCURRENCY, (id) =>
    verifySession(db, keys, id, options),
  );
}

export function serializeSessionVerification(v: SessionVerification) {
  return {
    session_id: v.chain.sessionId,
    ok: v.chain.ok,
    event_count: v.chain.count,
    head: v.chain.head,
    broke_at_seq: v.chain.brokeAtSeq,
    reason: v.chain.reason,
    emitter_tracked: v.emitter.tracked,
    emitter_complete: v.emitter.complete,
    emitter_first_gap: v.emitter.firstGap,
    // #152. `prefix` is the field that keeps an anchored answer honest: with
    // "attested", everything up to `verified_from_seq` is vouched for by the
    // checkpoint signature named in `anchor` rather than by rehashing it.
    verified_from_seq: v.chain.verifiedFromSeq,
    verified_to_seq: v.chain.verifiedToSeq,
    prefix: v.chain.prefix,
    // How many signed chain heads the recomputation passed through and agreed
    // with. Zero on a session that was never checkpointed, which is a fact
    // about the record rather than a failure — and one a reader should be able
    // to see, since it is the difference between "recomputed" and "recomputed
    // and pinned to something that was signed at the time".
    attested_heads_checked: v.chain.attestedHeadsChecked,
    anchor: v.anchor
      ? {
          checkpoint_id: v.anchor.checkpointId,
          checkpoint_seq: v.anchor.checkpointSeq,
          event_count: v.anchor.eventCount,
          head: v.anchor.head,
        }
      : null,
  };
}
