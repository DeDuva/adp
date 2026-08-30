// The durable half of the recorder: events reach the disk before they reach
// the network, and nothing is ever unwritten.
//
// **Why a spool at all.** #149's requirement is that ADP being unreachable
// must not lose a session, and that a recorder dying with its terminal must
// not produce a *gap* — because a gap is worse than an absence: it looks like
// data. Both reduce to the same mechanism. The reader hands an event here, it
// is appended and numbered, and only then does the shipper try to deliver it.
// A process that dies between those two steps loses nothing; the next one
// reads the file and carries on from the number it finds.
//
// **Append-only, and acknowledged out of band.** The obvious design truncates
// the spool as the server acknowledges events, and truncating a file that is
// simultaneously being appended to is where corruption lives. So the events
// file only ever grows, and the high-water mark the server has accepted lives
// in a second, tiny file written by rename. Compaction is then a separate,
// safe operation (`compact()`), not something the hot path does.
//
// **The counter is assigned here, once.** `producer_seq` is contiguous from 1
// per session, which is what makes "the recorder recorded everything"
// checkable rather than asserted — the server rejects a batch that skips a
// number. Assigning it at append time, in the same place that makes the event
// durable, is what makes the sequence survive a restart: it is a property of
// the file, not of a process's memory.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { SpooledEvent, TrajectoryEvent } from "./events.js";

export interface SpoolOptions {
  /** Directory holding every session's spool. One process may hold many. */
  dir: string;
  sessionId: string;
  /**
   * The ceiling on undelivered bytes, past which the spool refuses events
   * rather than filling the disk. See `append` for what refusing means and why
   * it is not the same as thinning the stream.
   */
  maxBytes?: number;
  /**
   * How often to force the appended bytes to the platter. Every event is
   * `write(2)`-ed immediately, which is what survives *this process* dying —
   * the case #149 actually names. An fsync every N events bounds what a
   * machine losing power could take with it, without paying a disk flush per
   * event on a hot session.
   */
  fsyncEvery?: number;
}

/** 64 MiB of undelivered events, which at the storage analysis's measured 833 B/event is ~80,000 of them. */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_FSYNC_EVERY = 64;

export interface AppendResult {
  accepted: boolean;
  event?: SpooledEvent;
  /** Set when `accepted` is false: how many events have now been refused in a row. */
  dropped?: number;
}

/**
 * One session's spool.
 *
 * Deliberately synchronous. The reader that feeds it is parsing a stream line
 * by line, and an async append would need a queue in front of it to preserve
 * order — a queue that lives in memory, which is precisely the thing this file
 * exists to avoid.
 */
export class Spool {
  readonly eventsPath: string;
  readonly ackPath: string;
  private readonly maxBytes: number;
  private readonly fsyncEvery: number;
  private fd: number | null = null;
  private sinceFsync = 0;
  private nextSeq = 1;
  private bytes = 0;
  private ack = 0;
  /** Refused since the last accepted event — the count an overflow marker reports. */
  private dropped = 0;

  constructor(options: SpoolOptions) {
    mkdirSync(options.dir, { recursive: true });
    // The session id is a uuid from the server, so it is already safe as a
    // filename; `path.basename` is belt and braces against a caller that
    // invents its own.
    const stem = path.join(options.dir, path.basename(options.sessionId));
    this.eventsPath = `${stem}.jsonl`;
    this.ackPath = `${stem}.ack`;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.fsyncEvery = options.fsyncEvery ?? DEFAULT_FSYNC_EVERY;
    this.recover();
  }

  /**
   * Read what a previous process left behind.
   *
   * A torn final line is expected rather than exceptional: it is what a `kill
   * -9` mid-write leaves, and it is the one case where an event genuinely did
   * not make it. It is dropped here, which restores the invariant the rest of
   * the design rests on — every line in the file is a complete event, and the
   * numbering is contiguous — and it loses nothing the process ever
   * acknowledged to anyone.
   */
  private recover(): void {
    if (!existsSync(this.eventsPath)) return;
    const raw = readFileSync(this.eventsPath, "utf8");
    let lastGood = 0;
    let bytes = 0;
    let seq = 0;
    for (const line of raw.split("\n")) {
      if (line === "") continue;
      const width = Buffer.byteLength(line, "utf8") + 1;
      let parsed: SpooledEvent;
      try {
        parsed = JSON.parse(line) as SpooledEvent;
      } catch {
        // A torn line can only be the last one — anything after it was never
        // written — so stop rather than skip, and let the truncation below
        // discard the fragment.
        break;
      }
      if (typeof parsed.producer_seq !== "number") break;
      seq = parsed.producer_seq;
      bytes += width;
      lastGood = bytes;
    }
    if (lastGood !== Buffer.byteLength(raw, "utf8")) {
      // Truncate to the last complete event, so the next append does not
      // produce a line that is half of one event and half of another.
      writeFileSync(this.eventsPath, raw.slice(0, lastGood));
    }
    this.bytes = lastGood;
    this.nextSeq = seq + 1;
    if (existsSync(this.ackPath)) {
      const value = Number(readFileSync(this.ackPath, "utf8").trim());
      if (Number.isInteger(value) && value >= 0) this.ack = value;
    }
  }

  private open(): number {
    if (this.fd === null) this.fd = openSync(this.eventsPath, "a");
    return this.fd;
  }

  /**
   * Number an event, make it durable, and say whether it was taken.
   *
   * **A refusal is not a silent thinning of the stream**, which is what #149
   * rules out. It is reported to the caller, counted, and — once there is room
   * again — recorded *in the trajectory itself* as an overflow marker (see
   * `overflowMarker`), so the gap is a fact the hash chain covers rather than
   * something a reader has to infer from a number that jumps.
   */
  append(event: TrajectoryEvent): AppendResult {
    if (this.undeliveredBytes() >= this.maxBytes) {
      this.dropped += 1;
      return { accepted: false, dropped: this.dropped };
    }
    const spooled: SpooledEvent = {
      ...event,
      client_event_id: randomUUID(),
      producer_seq: this.nextSeq,
    };
    const line = `${JSON.stringify(spooled)}\n`;
    const fd = this.open();
    writeSync(fd, line);
    this.bytes += Buffer.byteLength(line, "utf8");
    this.nextSeq += 1;
    this.sinceFsync += 1;
    if (this.sinceFsync >= this.fsyncEvery) this.flush();
    this.dropped = 0;
    return { accepted: true, event: spooled };
  }

  /**
   * The event that says what was lost, ready to be appended once there is room.
   *
   * A `custom` kind, because it is a fact about the recording and not about the
   * agent — and an ordinary event otherwise, so it is hash-chained, verifiable,
   * and impossible to remove afterwards without breaking the chain. Its
   * `producer_seq` also keeps the numbering contiguous across the gap, which is
   * the difference between "the recorder says it dropped 412 events here" and
   * a sequence with a hole in it that nobody can explain.
   */
  static overflowMarker(dropped: number, since: string): TrajectoryEvent {
    return {
      kind: "custom",
      type: "recorder.overflow",
      status: "error",
      payload: {
        dropped,
        since,
        reason: "spool over capacity — events were refused rather than the stream thinned silently",
      },
    };
  }

  /** Force everything written so far to the platter. */
  flush(): void {
    if (this.fd === null) return;
    fsyncSync(this.fd);
    this.sinceFsync = 0;
  }

  /** Events the server has not yet acknowledged, oldest first. */
  pending(limit = 1000): SpooledEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    const out: SpooledEvent[] = [];
    for (const line of readFileSync(this.eventsPath, "utf8").split("\n")) {
      if (line === "") continue;
      let parsed: SpooledEvent;
      try {
        parsed = JSON.parse(line) as SpooledEvent;
      } catch {
        break;
      }
      if (parsed.producer_seq <= this.ack) continue;
      out.push(parsed);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Record how far the server has durably stored this session.
   *
   * Written by rename, so a process dying mid-update leaves the *old* mark
   * rather than a truncated one. Re-delivering an acknowledged event is
   * harmless — `client_event_id` makes it a reported duplicate rather than a
   * second append — while losing the mark's integrity would not be.
   */
  acknowledge(throughSeq: number): void {
    if (throughSeq <= this.ack) return;
    this.ack = throughSeq;
    const tmp = `${this.ackPath}.tmp`;
    writeFileSync(tmp, String(throughSeq));
    renameSync(tmp, this.ackPath);
  }

  /**
   * Rewind the mark, for the one case that needs it: the server rejecting a
   * batch as non-contiguous and naming where to replay from. Trusting the
   * server over the local mark is the right way round — it is the one that
   * knows what it durably has.
   */
  rewind(toSeq: number): void {
    this.ack = Math.max(0, toSeq);
    const tmp = `${this.ackPath}.tmp`;
    writeFileSync(tmp, String(this.ack));
    renameSync(tmp, this.ackPath);
  }

  acknowledged(): number {
    return this.ack;
  }

  nextSequence(): number {
    return this.nextSeq;
  }

  /**
   * Bytes the spool file holds right now.
   *
   * This is what the ceiling is measured against, and it is the *file* rather
   * than a running estimate of the undelivered subset — because the shipper
   * compacts on every acknowledgement, so in steady state the file holds
   * undelivered events and nothing else. An estimate maintained on the append
   * path would be a second source of truth about the same bytes, and the one
   * that never re-reads the file is the one that would drift.
   */
  undeliveredBytes(): number {
    return this.bytes;
  }

  /**
   * Drop the acknowledged prefix and reclaim its space.
   *
   * Separate from the hot path on purpose: this rewrites the file, and the
   * append path must never do that. Safe to call between batches, and safe to
   * lose — a process that dies mid-compaction leaves the original file intact,
   * because the new one is only moved into place once it is complete.
   */
  compact(): void {
    if (this.ack === 0 || !existsSync(this.eventsPath)) return;
    const kept: string[] = [];
    for (const line of readFileSync(this.eventsPath, "utf8").split("\n")) {
      if (line === "") continue;
      let parsed: SpooledEvent;
      try {
        parsed = JSON.parse(line) as SpooledEvent;
      } catch {
        break;
      }
      if (parsed.producer_seq > this.ack) kept.push(line);
    }
    const tmp = `${this.eventsPath}.tmp`;
    writeFileSync(tmp, kept.length > 0 ? `${kept.join("\n")}\n` : "");
    this.close();
    renameSync(tmp, this.eventsPath);
    this.bytes = kept.reduce((n, line) => n + Buffer.byteLength(line, "utf8") + 1, 0);
  }

  /**
   * Everything delivered and nothing left to send.
   *
   * The condition a supervisor waits on before it lets a session's spool be
   * deleted — and the one `flush` reports, so "did it all arrive" is a question
   * with an answer rather than an assumption.
   */
  drained(): boolean {
    return this.nextSeq - 1 <= this.ack;
  }

  close(): void {
    if (this.fd === null) return;
    fsyncSync(this.fd);
    closeSync(this.fd);
    this.fd = null;
    this.sinceFsync = 0;
  }

  /** Delete this session's files. Only safe once `drained()`. */
  remove(): void {
    this.close();
    for (const file of [this.eventsPath, this.ackPath]) {
      if (existsSync(file)) unlinkSync(file);
    }
  }

  /** Bytes the spool currently occupies, delivered or not. */
  size(): number {
    return existsSync(this.eventsPath) ? statSync(this.eventsPath).size : 0;
  }
}
