// The three parts, wired: a reader turning a harness's stream into events, a
// spool making them durable, and a shipper delivering them.
//
// **Recording is out of band, and that is the thesis rather than an
// optimisation of it.** Nothing here runs inside the agent's context window:
// this process reads a stream the harness was already producing. Arm 2
// measured what the alternative costs without even paying it — the MCP arm
// recorded no trajectory at all and still cost $0.1435/trial against $0.0848
// via `gh`, and that gap is protocol round-trips. Per-event recording through
// an agent-visible tool is the one workload that would multiply it, in exactly
// the measurement a prospect uses to compare us.
//
// So the only thing on the agent's path is a pipe. Everything expensive —
// batching, retry, the session lifecycle — happens on this side of it.
import { TrajectoryClient } from "./client.js";
import type { TrajectoryEvent } from "./events.js";
import { Shipper, type ShipReport } from "./shipper.js";
import { Spool } from "./spool.js";
import { writeSessionMeta, type SessionMeta } from "./session.js";

export interface RecorderOptions {
  client: TrajectoryClient;
  spoolDir: string;
  meta: SessionMeta;
  producerId: string;
  batchSize?: number;
  maxSpoolBytes?: number;
}

export interface Reader {
  read(line: string): TrajectoryEvent[];
  end(): TrajectoryEvent[];
  sessionFacts?(): { harnessSessionId?: string; model?: string };
}

export class Recorder {
  private readonly spool: Spool;
  private meta: SessionMeta;
  private shipper: Shipper | null = null;
  /** Events the spool refused since the last one it took — see `appendEvent`. */
  private overflowed = 0;
  private overflowSince: string | null = null;

  constructor(
    private readonly options: RecorderOptions,
    private readonly reader: Reader,
  ) {
    this.meta = options.meta;
    this.spool = new Spool({
      dir: options.spoolDir,
      sessionId: options.meta.localId,
      maxBytes: options.maxSpoolBytes,
    });
  }

  /** Feed one line of the harness's stream. Never throws: a recorder that dies takes the session with it. */
  record(line: string): void {
    for (const event of this.reader.read(line)) this.appendEvent(event);
    const facts = this.reader.sessionFacts?.();
    if (facts?.harnessSessionId && facts.harnessSessionId !== this.meta.harnessSessionId) {
      this.meta = { ...this.meta, harnessSessionId: facts.harnessSessionId };
      writeSessionMeta(this.options.spoolDir, this.meta);
    }
  }

  /**
   * Append, and keep the record honest when the spool is full.
   *
   * The marker goes in *before* the event that finally fits, so the trajectory
   * reads in the order things happened: N events refused, then recording
   * resumes. Putting it after would date the gap wrongly by one event, which
   * is a small lie in the one record whose whole value is that it is not.
   */
  private appendEvent(event: TrajectoryEvent): void {
    if (this.overflowed > 0) {
      const marker = this.spool.append(Spool.overflowMarker(this.overflowed, this.overflowSince ?? "unknown"));
      if (!marker.accepted) {
        // Still no room. The refusal count keeps climbing rather than the
        // marker being dropped — the gap gets recorded whenever it can be,
        // and it is never rounded down.
        this.overflowed += 1;
        return;
      }
      this.overflowed = 0;
      this.overflowSince = null;
    }

    const result = this.spool.append(event);
    if (!result.accepted) {
      if (this.overflowed === 0) this.overflowSince = new Date().toISOString();
      this.overflowed = result.dropped ?? this.overflowed + 1;
    }
  }

  /**
   * Make sure ADP knows about this session, then deliver what is spooled.
   *
   * Session creation is lazy and retried here rather than done once at
   * startup, because a recorder started while ADP is down must still record.
   * Until the id exists there is nothing to ship *to*, so the report says
   * `waiting` and the events accumulate — which is the correct behaviour and
   * the one the spool was built for.
   */
  async flush(): Promise<ShipReport> {
    if (this.meta.sessionId === null) {
      try {
        const session = await this.options.client.startSession(this.meta.owner, this.meta.repo, {
          harness: this.meta.harness,
          intent_id: this.meta.intentId,
          run_id: this.meta.runId,
        });
        this.meta = { ...this.meta, sessionId: session.id };
        writeSessionMeta(this.options.spoolDir, this.meta);
      } catch (err) {
        return {
          state: "waiting",
          delivered: 0,
          duplicates: 0,
          acknowledged: this.spool.acknowledged(),
          pending: this.spool.pending().length,
          reason: `no session yet: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (this.shipper === null) {
      this.shipper = new Shipper({
        client: this.options.client,
        spool: this.spool,
        owner: this.meta.owner,
        repo: this.meta.repo,
        sessionId: this.meta.sessionId!,
        producerId: this.options.producerId,
        batchSize: this.options.batchSize,
      });
    }
    return this.shipper.drain();
  }

  /**
   * Finish: drain what the reader has left, deliver it, and record that the
   * session ended.
   *
   * `endedAt` is written whatever happens, including when delivery failed — it
   * marks the spool as one a later `flush` should finish rather than one a
   * live recorder is still filling. A spool nobody will add to and nobody
   * knows is finished is how events sit on a disk forever.
   */
  async close(): Promise<ShipReport> {
    for (const event of this.reader.end()) this.appendEvent(event);
    this.spool.flush();
    const report = await this.flush();
    this.meta = { ...this.meta, endedAt: new Date().toISOString() };
    writeSessionMeta(this.options.spoolDir, this.meta);
    this.spool.close();
    return report;
  }

  sessionMeta(): SessionMeta {
    return { ...this.meta };
  }

  drained(): boolean {
    return this.spool.drained();
  }
}
