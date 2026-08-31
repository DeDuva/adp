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
import { Lifecycle, type Boundary, type Outcome } from "./lifecycle.js";
import { normalizeEvent, type TrajectoryEvent } from "./events.js";
import { Shipper, type ShipReport } from "./shipper.js";
import { Spool } from "./spool.js";
import { writeSessionMeta, type SessionMeta } from "./session.js";
// The reader contract lives with the readers, because it is the thing a
// third-party reader is written against — see `readers/index.ts`. It is
// re-exported here so that the older import path keeps working.
import type { Reader } from "./readers/index.js";

export type { Reader };

export interface RecorderOptions {
  client: TrajectoryClient;
  spoolDir: string;
  meta: SessionMeta;
  producerId: string;
  batchSize?: number;
  maxSpoolBytes?: number;
  /** The lifecycle (#151). Absent means events only — no checkpoints, no terminal state. */
  lifecycle?: Lifecycle;
  /** The session to resume rather than start, when the harness is continuing one. */
  resumeFromSessionId?: string;
}

export class Recorder {
  private readonly spool: Spool;
  private meta: SessionMeta;
  private shipper: Shipper | null = null;
  /** Events the spool refused since the last one it took — see `appendEvent`. */
  private overflowed = 0;
  private overflowSince: string | null = null;
  private checkpoints = 0;
  private deferredCheckpoints = 0;
  /** Things worth telling the person running this, collected rather than printed as they happen. */
  private readonly notes: string[] = [];

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
  private appendEvent(raw: TrajectoryEvent): void {
    // Every reader's output crosses this line, including one this repository
    // did not write. See `normalizeEvent`: an out-of-vocabulary event is a
    // 422, a 422 quarantines the session, so the check has to happen before
    // the spool rather than at ingest.
    const event = normalizeEvent(raw);
    this.options.lifecycle?.observe(event);
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
   * Start the session — or continue one, when the harness is continuing one.
   *
   * **A failed resume falls back to a fresh session, and says so.** Refusing to
   * record because the lineage link could not be made would trade the whole
   * trajectory for an edge: ADP declines a resume whose checkpoint it cannot
   * verify, or that has no checkpoint at all, and both are ordinary — a
   * previous session that never reached a commit ADP holds has nothing to
   * resume from. An unlinked recording beats no recording, and the gap is
   * reported rather than hidden.
   */
  private async openSession(): Promise<{ id: string }> {
    const resumeFrom = this.options.resumeFromSessionId;
    if (resumeFrom) {
      try {
        const resumed = await this.options.client.resumeSession(this.meta.owner, this.meta.repo, resumeFrom, {
          harness: this.meta.harness,
        });
        this.meta = { ...this.meta, resumedFromSessionId: resumeFrom };
        return resumed;
      } catch (err) {
        this.notes.push(
          `could not resume ${resumeFrom} (${err instanceof Error ? err.message : String(err)}) — ` +
            `recording as a new session instead`,
        );
      }
    }
    return this.options.client.startSession(this.meta.owner, this.meta.repo, {
      harness: this.meta.harness,
      intent_id: this.meta.intentId,
      run_id: this.meta.runId,
    });
  }

  /**
   * Take a checkpoint if a boundary is due — asked once per flush, after
   * delivery.
   *
   * **After delivery, never before.** A checkpoint signs the chain head as of
   * that moment, so one taken while a hundred events sat undelivered in the
   * spool would commit to a head that is about to move and describe a session
   * shorter than it was. Delivering first costs nothing and makes the signed
   * head the real one.
   */
  private async checkpointIfDue(due: { boundary: Boundary; gitSha: string } | null): Promise<void> {
    if (!due || this.meta.sessionId === null) return;
    const result = await this.options.client.createCheckpoint(
      this.meta.owner,
      this.meta.repo,
      this.meta.sessionId,
      {
        git_sha: due.gitSha,
        harness: this.meta.harness,
        // What a resume needs and nothing more. The harness's own handle is
        // the useful half — `claude --resume <id>` and `codex resume <id>`
        // both take it — and the rest is provenance for whoever reads the
        // checkpoint later wondering which process wrote it.
        state: {
          boundary: due.boundary,
          harness: this.meta.harness,
          harness_session_id: this.meta.harnessSessionId ?? null,
          producer_id: this.options.producerId,
          events_acknowledged: this.spool.acknowledged(),
        },
      },
    );
    if (result.outcome === "created") {
      this.checkpoints += 1;
      this.options.lifecycle?.checkpointed(due.gitSha);
      return;
    }
    if (result.outcome === "unresolvable") {
      // The ordinary case, not an error: they committed and have not pushed.
      // The boundary is left standing so the next tick tries again, which is
      // what turns "checkpoint on commit" into "checkpoint on a commit ADP can
      // actually resume from".
      this.deferredCheckpoints += 1;
      return;
    }
    this.notes.push(`checkpoint failed: ${result.message}`);
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
        const session = await this.openSession();
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
    const report = await this.shipper.drain();
    await this.checkpointIfDue(this.options.lifecycle?.due() ?? null);
    return report;
  }

  /**
   * Finish: drain what the reader has left, deliver it, checkpoint, and tell
   * ADP how the session ended.
   *
   * `endedAt` is written whatever happens, including when delivery failed — it
   * marks the spool as one a later `flush` should finish rather than one a
   * live recorder is still filling. A spool nobody will add to and nobody
   * knows is finished is how events sit on a disk forever.
   *
   * **The session is ended only once the spool is drained**, and that ordering
   * is not a nicety. A closed session refuses appends, so closing over
   * undelivered events would make them permanently undeliverable — the
   * recorder would have destroyed the tail of the recording in the act of
   * tidying up. Undrained, the terminal state stays on disk as an intention
   * and `adp-recorder flush` carries it out after it has delivered the rest.
   */
  async close(outcome: Outcome = "suspended"): Promise<ShipReport> {
    for (const event of this.reader.end()) this.appendEvent(event);
    this.spool.flush();
    const report = await this.flush();

    // The last checkpoint, taken whatever else happened, so an interrupted
    // session has somewhere to resume from. This is the boundary that makes
    // "killing it produces a suspended session with a usable checkpoint" true
    // rather than a hope.
    await this.checkpointIfDue(this.options.lifecycle?.final() ?? null);

    this.meta = { ...this.meta, endedAt: new Date().toISOString(), outcome };
    if (this.meta.sessionId !== null && this.spool.drained()) {
      const ended = await this.options.client.endSession(
        this.meta.owner,
        this.meta.repo,
        this.meta.sessionId,
        outcome,
      );
      if (ended.ok) this.meta = { ...this.meta, terminated: true };
      else this.notes.push(`could not mark the session ${outcome}: ${ended.message}`);
    }
    writeSessionMeta(this.options.spoolDir, this.meta);
    this.spool.close();
    return { ...report, notes: this.lifecycleNotes() };
  }

  /** What the lifecycle did, for the one line a session ends with. */
  lifecycleNotes(): string[] {
    const notes = [...this.notes];
    if (this.checkpoints > 0) notes.push(`${this.checkpoints} checkpoint(s)`);
    if (this.deferredCheckpoints > 0) {
      notes.push(
        `${this.deferredCheckpoints} checkpoint(s) skipped — the commit is not in ADP yet, so push to make it resumable`,
      );
    }
    if (this.meta.resumedFromSessionId) notes.push(`resumed ${this.meta.resumedFromSessionId}`);
    if (this.meta.endedAt && !this.meta.terminated) {
      notes.push(`session not yet marked ${this.meta.outcome} — 'adp-recorder flush' will finish it`);
    }
    return notes;
  }

  sessionMeta(): SessionMeta {
    return { ...this.meta };
  }

  drained(): boolean {
    return this.spool.drained();
  }
}
