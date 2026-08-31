// Draining a spool into ADP, and deciding what each answer means.
//
// The shipper owns exactly one hard question — **what to do when delivery does
// not simply succeed** — and the whole reason it is a separate file from the
// spool is that the answers are policy rather than mechanism:
//
//   accepted    trust the server's `accepted_through`, not the local count,
//               and compact the spool up to it
//   gap         the server is waiting for a different number: rewind to it and
//               replay. It knows what it durably has; the local mark does not
//   unavailable keep everything, back off, try again. This is the case the
//               spool exists for and it must never lose anything
//   refused     stop. A 422 does not become true by waiting, and a recorder
//               that retries one forever is a denial-of-service against the
//               server it is supposed to be recording into
//
// The last one deserves its name. **Quarantine is not a drop**: the events
// stay in the spool, the session is marked, and an operator is told which
// batch and why. A recorder that discarded a rejected batch to keep moving
// would be manufacturing exactly the gap #149 exists to prevent, and it would
// look like a clean run while doing it.
import type { SpooledEvent } from "./events.js";
import type { AppendOutcome, TrajectoryClient } from "./client.js";
import { Spool } from "./spool.js";

export interface ShipperOptions {
  client: TrajectoryClient;
  spool: Spool;
  owner: string;
  repo: string;
  sessionId: string;
  /** Recorded on every event of a batch; the server never branches on it. */
  producerId: string;
  /** Events per request. The endpoint's own ceiling is 1000. */
  batchSize?: number;
  /** First retry delay; doubles per consecutive failure up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
}

export type ShipState = "idle" | "shipping" | "waiting" | "quarantined";

export interface ShipReport {
  state: ShipState;
  /** Delivered in this call. */
  delivered: number;
  /** Reported by the server as already present — a retry that did no harm. */
  duplicates: number;
  acknowledged: number;
  pending: number;
  /** Set when quarantined: why, in the server's own words. */
  reason?: string;
  /** Set when waiting: how long before the next attempt is worth making. */
  retryInMs?: number;
  /**
   * What the session's lifecycle did, when the report is the one a session ends
   * with (#151) — checkpoints taken, checkpoints deferred, a resume that could
   * not be made. Empty on an ordinary drain: the shipper does not produce
   * these, it only carries them.
   */
  notes?: string[];
}

export const DEFAULT_BATCH_SIZE = 200;
export const DEFAULT_BACKOFF_MS = 500;
export const DEFAULT_MAX_BACKOFF_MS = 30_000;

export class Shipper {
  private readonly batchSize: number;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private consecutiveFailures = 0;
  private state: ShipState = "idle";
  private reason: string | undefined;
  /** The last gap the server reported, so the same one twice is caught rather than obeyed. */
  private lastGapSeq: number | null = null;

  constructor(private readonly options: ShipperOptions) {
    this.batchSize = Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, 1000);
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  }

  /** Exponential, capped. Deterministic, so a test can assert on it. */
  retryDelayMs(): number {
    const exponent = Math.max(0, this.consecutiveFailures - 1);
    return Math.min(this.backoffMs * 2 ** exponent, this.maxBackoffMs);
  }

  quarantined(): boolean {
    return this.state === "quarantined";
  }

  /**
   * Deliver as much as the server will take, once.
   *
   * Loops over batches while they keep succeeding, so a spool that built up
   * during an outage drains in one call rather than one batch per tick — which
   * matters because the outage is exactly when the backlog is largest.
   */
  async drain(): Promise<ShipReport> {
    if (this.state === "quarantined") {
      return this.report(0, 0, { state: "quarantined", reason: this.reason });
    }

    let delivered = 0;
    let duplicates = 0;

    for (;;) {
      const batch = this.options.spool.pending(this.batchSize);
      if (batch.length === 0) {
        this.consecutiveFailures = 0;
        this.state = "idle";
        return this.report(delivered, duplicates, { state: "idle" });
      }

      const outcome = await this.options.client.appendEvents(
        this.options.owner,
        this.options.repo,
        this.options.sessionId,
        batch,
        this.options.producerId,
      );

      const step = this.apply(outcome, batch);
      delivered += step.delivered;
      duplicates += step.duplicates;
      if (!step.continue) return this.report(delivered, duplicates, step.report);
    }
  }

  private apply(
    outcome: AppendOutcome,
    batch: SpooledEvent[],
  ): { continue: boolean; delivered: number; duplicates: number; report: Partial<ShipReport> } {
    switch (outcome.outcome) {
      case "accepted": {
        // `accepted_through` over the local count, always. It is the server
        // saying what it durably holds; the batch we sent is only what we
        // hoped it would hold. They agree in the ordinary case and the
        // disagreement is the interesting one.
        //
        // Null means this session is untracked — no event in it ever carried a
        // producer_seq. The spool always sets one, so this can only happen if
        // something else appended to the same session; fall back to the batch's
        // own last number rather than stalling forever on a null.
        const through = outcome.acceptedThrough ?? batch[batch.length - 1]!.producer_seq;
        const before = this.options.spool.acknowledged();
        this.options.spool.acknowledge(through);
        this.options.spool.compact();

        // **The loop has to be able to end.** `drain` keeps going while
        // batches succeed, which is what empties a backlog built up during an
        // outage in one pass — and it means a server answering 201 without
        // ever advancing `accepted_through` would have this process re-sending
        // the same batch at full speed, forever: a denial-of-service written
        // by us, aimed at the thing we are recording into. It showed up the
        // first time a test modelled a server whose mark stood still. Progress
        // is a precondition of continuing, not an assumption.
        if (this.options.spool.acknowledged() <= before) {
          this.state = "quarantined";
          this.reason =
            `server accepted a batch through producer_seq ${through} but its mark did not advance past ` +
            `${before} — refusing to resend the same batch in a loop`;
          return {
            continue: false,
            delivered: outcome.appended,
            duplicates: outcome.duplicates.length,
            report: { state: "quarantined", reason: this.reason },
          };
        }

        this.consecutiveFailures = 0;
        this.lastGapSeq = null;
        this.state = "shipping";
        return {
          continue: true,
          delivered: outcome.appended,
          duplicates: outcome.duplicates.length,
          report: { state: "shipping" },
        };
      }

      case "gap": {
        // The server is waiting for a number we are past — which happens when
        // an acknowledgement was lost in flight, or when a spool was restored
        // from a copy. Rewinding to what it asks for and replaying is safe
        // precisely because `client_event_id` makes the overlap a reported
        // duplicate rather than a second append.
        // The same guard the accepted branch needs, for the same reason: a
        // server that answers every batch with the same `expected_next_seq`
        // would have this rewinding and replaying to the same place at full
        // speed. Obeying the instruction once is recovery; obeying it twice
        // unchanged means it is not an instruction, it is a loop.
        if (this.lastGapSeq === outcome.expectedNextSeq) {
          this.state = "quarantined";
          this.reason =
            `server asked twice to replay from producer_seq ${outcome.expectedNextSeq} without accepting it — ` +
            `refusing to rewind in a loop`;
          return {
            continue: false,
            delivered: 0,
            duplicates: 0,
            report: { state: "quarantined", reason: this.reason },
          };
        }
        this.lastGapSeq = outcome.expectedNextSeq;
        this.options.spool.rewind(outcome.expectedNextSeq - 1);
        this.consecutiveFailures = 0;
        this.state = "shipping";
        return { continue: true, delivered: 0, duplicates: 0, report: { state: "shipping" } };
      }

      case "unavailable": {
        this.consecutiveFailures += 1;
        this.state = "waiting";
        return {
          continue: false,
          delivered: 0,
          duplicates: 0,
          report: { state: "waiting", retryInMs: this.retryDelayMs(), reason: outcome.message },
        };
      }

      case "refused": {
        this.state = "quarantined";
        this.reason = `HTTP ${outcome.status}: ${outcome.message}`;
        return {
          continue: false,
          delivered: 0,
          duplicates: 0,
          report: { state: "quarantined", reason: this.reason },
        };
      }
    }
  }

  private report(delivered: number, duplicates: number, extra: Partial<ShipReport>): ShipReport {
    return {
      state: this.state,
      delivered,
      duplicates,
      acknowledged: this.options.spool.acknowledged(),
      pending: this.options.spool.pending(this.batchSize).length,
      ...extra,
    };
  }
}
