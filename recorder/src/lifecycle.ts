// When to checkpoint, and how a session ended.
//
// **The lifecycle's three decisions all had the wrong actor** (#151). Starting,
// checkpointing and closing a session were each a call somebody had to
// remember to make, mid-task — so sessions existed only when an agent was
// prompted well enough, checkpoints existed only when someone was thinking
// about checkpointing, and every session that ended stayed `active` forever.
// An unclosed session is indistinguishable from an abandoned one, and
// `runs.close` binds `final_git_sha` to every session's chain head, so a
// session left open is a run that cannot be attested.
//
// **Boundaries, not intervals.** That is the judgement the issue flags and it
// is the whole design of this file. A checkpoint on a timer is a DSSE
// signature over opaque state every N seconds, most of them signing the same
// state as the last; a checkpoint at a boundary is a place someone would
// actually want to return to. Four boundaries, and no fifth:
//
//   commit   HEAD moved. The strongest of them — a resume wants a commit,
//            and this is the recorder noticing one without being told.
//   handoff  the reader emitted a `handoff` event. Neither shipped reader
//            does yet; the vocabulary has the kind, so the rule is written
//            once rather than added when one does.
//   idle     nothing for a while, with work recorded since the last
//            checkpoint. The agent stopped, whether or not anyone said so.
//   final    the stream ended. Always taken, so a suspended session has
//            something to resume from.
//
// The idle threshold is the one number here, and it is a threshold rather than
// a period: it fires once per quiet stretch, not once per interval inside one.
import type { TrajectoryEvent } from "./events.js";
import { headSha } from "./git.js";

export type Boundary = "commit" | "handoff" | "idle" | "final";

/** How a session ended. Not an opinion — the two are different facts. */
export type Outcome = "closed" | "suspended";

export interface LifecycleOptions {
  /** The checkout the harness is working in. Boundaries that need git are skipped without one. */
  dir: string;
  /** Quiet time before an idle boundary. Default 5 minutes: long enough that a thinking agent is not "idle". */
  idleMs?: number;
  now?: () => number;
  headSha?: (dir: string) => string | null;
}

export const DEFAULT_IDLE_MS = 5 * 60_000;

export class Lifecycle {
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly readHead: (dir: string) => string | null;

  private lastEventAt: number;
  /** Events recorded since the last checkpoint. A checkpoint over nothing new is noise. */
  private sinceCheckpoint = 0;
  private handoffPending = false;
  /** The sha the last checkpoint named, so an unmoved HEAD is not a boundary twice. */
  private checkpointedSha: string | null = null;
  /** Set once an idle boundary fires, cleared by the next event: once per quiet stretch. */
  private idleReported = false;

  constructor(private readonly options: LifecycleOptions) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.now = options.now ?? Date.now;
    this.readHead = options.headSha ?? headSha;
    this.lastEventAt = this.now();
  }

  /** Every event the recorder spools passes here; nothing is stored but the shape of the session. */
  observe(event: TrajectoryEvent): void {
    this.sinceCheckpoint += 1;
    this.lastEventAt = this.now();
    this.idleReported = false;
    if (event.kind === "handoff") this.handoffPending = true;
  }

  /**
   * The boundary due now, if any — asked once per flush tick.
   *
   * Ordered by how much the boundary is worth: a commit is a place to return
   * to, a handoff is a change of author, and idle is merely the absence of
   * activity. When two are true at once the more meaningful one wins, and the
   * other is not queued behind it — the checkpoint that results covers both.
   */
  due(): { boundary: Boundary; gitSha: string } | null {
    if (this.sinceCheckpoint === 0) return null;
    const sha = this.readHead(this.options.dir);
    // Every checkpoint names a commit, so without one there is nothing to
    // checkpoint *at*. That is the honest limit of watching from outside: a
    // harness working in no repository still gets its whole trajectory, and no
    // resumable state.
    if (!sha) return null;

    if (sha !== this.checkpointedSha && this.checkpointedSha !== null) {
      return { boundary: "commit", gitSha: sha };
    }
    if (this.handoffPending) return { boundary: "handoff", gitSha: sha };
    // The first checkpoint of a session has no previous sha to differ from, so
    // it waits for one of the other three rather than firing on the first tick
    // — which would checkpoint the state the session started in and call it a
    // boundary.
    if (this.checkpointedSha === null && !this.idleDue()) return null;
    if (this.idleDue()) {
      this.idleReported = true;
      return { boundary: "idle", gitSha: sha };
    }
    return null;
  }

  /** The last one, taken whatever else is true, so an interrupted session is resumable. */
  final(): { boundary: Boundary; gitSha: string } | null {
    const sha = this.readHead(this.options.dir);
    if (!sha) return null;
    if (this.sinceCheckpoint === 0 && this.checkpointedSha === sha) return null;
    return { boundary: "final", gitSha: sha };
  }

  private idleDue(): boolean {
    return !this.idleReported && this.now() - this.lastEventAt >= this.idleMs;
  }

  /** Called when a checkpoint was actually created — not when one was refused. */
  checkpointed(gitSha: string): void {
    this.checkpointedSha = gitSha;
    this.sinceCheckpoint = 0;
    this.handoffPending = false;
  }

  /**
   * Seed the sha a session starts at, without treating it as a checkpoint.
   *
   * A recorder that started at commit A and saw the harness commit B must see
   * a boundary at B. One that started at A and never saw a commit must not.
   */
  startedAt(gitSha: string | null): void {
    this.checkpointedSha = gitSha;
  }

  /** For the report a session ends with. */
  eventsSinceCheckpoint(): number {
    return this.sinceCheckpoint;
  }
}
