import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Spool } from "./spool.js";
import type { TrajectoryEvent } from "./events.js";

const SESSION = "11111111-2222-3333-4444-555555555555";

function message(text: string): TrajectoryEvent {
  return { kind: "message", type: "assistant", payload: { text } };
}

describe("Spool", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "adp-recorder-spool-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("numbers events contiguously from 1 and gives each its own id", () => {
    // The two guarantees the server checks: `client_event_id` makes a retry
    // idempotent, `producer_seq` makes a drop detectable. Both are the
    // recorder's job, not the reader's.
    const spool = new Spool({ dir, sessionId: SESSION });
    const ids = new Set<string>();
    for (let i = 1; i <= 5; i += 1) {
      const result = spool.append(message(`m${i}`));
      expect(result.accepted).toBe(true);
      expect(result.event!.producer_seq).toBe(i);
      ids.add(result.event!.client_event_id);
    }
    expect(ids.size).toBe(5);
    spool.close();
  });

  it("resumes its numbering from the file after the process dies", () => {
    // The "survives its shell" case, which is the whole reason the counter is
    // a property of the file rather than of a process's memory. A recorder
    // that restarted at 1 would make the server reject the batch as
    // non-contiguous — visibly, but only after the damage.
    const first = new Spool({ dir, sessionId: SESSION });
    first.append(message("a"));
    first.append(message("b"));
    first.close();

    const second = new Spool({ dir, sessionId: SESSION });
    expect(second.nextSequence()).toBe(3);
    expect(second.append(message("c")).event!.producer_seq).toBe(3);
    expect(second.pending().map((e) => e.producer_seq)).toEqual([1, 2, 3]);
    second.close();
  });

  it("discards a torn final line and carries on from the last whole event", () => {
    // What `kill -9` mid-write leaves. The fragment is the one event that
    // genuinely did not make it; every line before it is complete, and the
    // invariant the rest of the design rests on is restored by dropping it.
    const spool = new Spool({ dir, sessionId: SESSION });
    spool.append(message("a"));
    spool.append(message("b"));
    spool.close();
    appendFileSync(spool.eventsPath, '{"kind":"message","produc');

    const recovered = new Spool({ dir, sessionId: SESSION });
    expect(recovered.pending().map((e) => e.producer_seq)).toEqual([1, 2]);
    expect(recovered.nextSequence()).toBe(3);
    // And the next append produces a readable file rather than one line that
    // is half of two events.
    recovered.append(message("c"));
    recovered.close();
    const lines = readFileSync(recovered.eventsPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("keeps the acknowledgement mark across a restart", () => {
    const spool = new Spool({ dir, sessionId: SESSION });
    spool.append(message("a"));
    spool.append(message("b"));
    spool.append(message("c"));
    spool.acknowledge(2);
    spool.close();

    const resumed = new Spool({ dir, sessionId: SESSION });
    expect(resumed.acknowledged()).toBe(2);
    expect(resumed.pending().map((e) => e.producer_seq)).toEqual([3]);
    resumed.close();
  });

  it("never moves the mark backwards on acknowledge, and only ever on rewind", () => {
    // Two different intents that must not be one method: a late
    // acknowledgement arriving out of order must not un-deliver anything,
    // while the server explicitly asking to replay must be obeyed.
    const spool = new Spool({ dir, sessionId: SESSION });
    for (let i = 0; i < 5; i += 1) spool.append(message(`m${i}`));
    spool.acknowledge(4);
    spool.acknowledge(2);
    expect(spool.acknowledged()).toBe(4);
    spool.rewind(1);
    expect(spool.acknowledged()).toBe(1);
    expect(spool.pending().map((e) => e.producer_seq)).toEqual([2, 3, 4, 5]);
    spool.close();
  });

  it("compacts away the delivered prefix without disturbing what is left", () => {
    const spool = new Spool({ dir, sessionId: SESSION });
    for (let i = 1; i <= 6; i += 1) spool.append(message(`m${i}`));
    spool.acknowledge(4);
    const before = spool.size();
    spool.compact();
    expect(spool.size()).toBeLessThan(before);
    expect(spool.pending().map((e) => e.producer_seq)).toEqual([5, 6]);
    // And the numbering does not restart just because the file got shorter.
    expect(spool.append(message("m7")).event!.producer_seq).toBe(7);
    spool.close();
  });

  it("survives a compaction that never finished", () => {
    // The temp file is written first and moved into place last, so a process
    // that dies mid-compaction leaves the original intact and an orphan
    // beside it.
    const spool = new Spool({ dir, sessionId: SESSION });
    for (let i = 1; i <= 3; i += 1) spool.append(message(`m${i}`));
    spool.close();
    writeFileSync(`${spool.eventsPath}.tmp`, "half a fi");

    const resumed = new Spool({ dir, sessionId: SESSION });
    expect(resumed.pending().map((e) => e.producer_seq)).toEqual([1, 2, 3]);
    resumed.close();
  });

  it("refuses events rather than filling the disk, and counts what it refused", () => {
    // Backpressure that degrades honestly (#149): the refusal is *reported*,
    // so the caller can record the gap. What must never happen here is the
    // event being accepted and quietly dropped.
    const spool = new Spool({ dir, sessionId: SESSION, maxBytes: 300 });
    let accepted = 0;
    let lastDropped = 0;
    for (let i = 0; i < 40; i += 1) {
      const result = spool.append(message(`m${i}`));
      if (result.accepted) accepted += 1;
      else lastDropped = result.dropped!;
    }
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(40);
    expect(lastDropped).toBe(40 - accepted);

    // Nothing that was accepted is missing: the sequence is still contiguous.
    expect(spool.pending().map((e) => e.producer_seq)).toEqual(
      Array.from({ length: accepted }, (_, i) => i + 1),
    );
    spool.close();
  });

  it("describes the gap as an event the chain will cover", () => {
    const marker = Spool.overflowMarker(412, "2026-08-30T10:00:00.000Z");
    expect(marker.kind).toBe("custom");
    expect(marker.type).toBe("recorder.overflow");
    // `error`, not `success`: a reader scanning statuses should find it.
    expect(marker.status).toBe("error");
    expect(marker.payload).toMatchObject({ dropped: 412 });
  });

  it("makes room again once the backlog is delivered", () => {
    const spool = new Spool({ dir, sessionId: SESSION, maxBytes: 300 });
    while (spool.append(message("filler")).accepted) {
      /* fill it */
    }
    const filled = spool.nextSequence() - 1;
    spool.acknowledge(filled);
    spool.compact();
    const after = spool.append(Spool.overflowMarker(3, "2026-08-30T10:00:00.000Z"));
    expect(after.accepted).toBe(true);
    // The marker takes the next number, so the sequence stays contiguous
    // across the gap — which is what makes "412 events were refused here"
    // legible instead of a hole nobody can explain.
    expect(after.event!.producer_seq).toBe(filled + 1);
    spool.close();
  });

  it("reports drained only once everything is acknowledged", () => {
    const spool = new Spool({ dir, sessionId: SESSION });
    expect(spool.drained()).toBe(true);
    spool.append(message("a"));
    expect(spool.drained()).toBe(false);
    spool.acknowledge(1);
    expect(spool.drained()).toBe(true);
    spool.close();
  });

  it("keeps one session's spool out of another's", () => {
    const a = new Spool({ dir, sessionId: SESSION });
    const b = new Spool({ dir, sessionId: "99999999-8888-7777-6666-555555555555" });
    a.append(message("a1"));
    b.append(message("b1"));
    b.append(message("b2"));
    expect(a.pending()).toHaveLength(1);
    expect(b.pending()).toHaveLength(2);
    // Each chain has exactly one writer, so each numbering starts at 1.
    expect(a.pending()[0]!.producer_seq).toBe(1);
    expect(b.pending()[0]!.producer_seq).toBe(1);
    a.close();
    b.close();
  });
});
