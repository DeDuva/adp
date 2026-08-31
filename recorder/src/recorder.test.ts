import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TrajectoryClient } from "./client.js";
import { ClaudeCodeReader } from "./readers/claude-code.js";
import { Recorder } from "./recorder.js";
import { Spool } from "./spool.js";
import { listSessions, newSessionMeta, readSessionMeta } from "./session.js";
import { tailFile } from "./tail.js";
import type { TrajectoryEvent } from "./events.js";

const assistantText = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });

interface Recorded {
  url: string;
  body: { events?: { producer_seq: number; client_event_id: string; kind: string }[]; harness?: string };
}

describe("Recorder", () => {
  let server: Server;
  let port: number;
  let requests: Recorded[];
  let sessionsUp: boolean;
  /** The terminal state each `close` asked for, in order. */
  let ended: string[];
  let stored: number;
  let dir: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push({ url: req.url!, body });
        // #151: `close` ends the session, and a fake ADP that does not answer
        // it turns every test that finishes a session into a timeout.
        if (req.url!.endsWith("/close")) {
          ended.push(body.status as string);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "22222222-3333-4444-5555-666666666666", status: body.status }));
          return;
        }
        if (req.url!.endsWith("/sessions")) {
          if (!sessionsUp) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: "down" }));
            return;
          }
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "22222222-3333-4444-5555-666666666666", harness: body.harness }));
          return;
        }
        const events = body.events as { producer_seq: number }[];
        stored = Math.max(stored, events[events.length - 1]!.producer_seq);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            appended: events.length,
            duplicates: [],
            count: stored,
            head: "abc",
            accepted_through: stored,
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = [];
    ended = [];
    sessionsUp = true;
    stored = 0;
    dir = mkdtempSync(path.join(tmpdir(), "adp-recorder-e2e-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function recorder(overrides: { maxSpoolBytes?: number } = {}) {
    const meta = newSessionMeta({ dir, owner: "acme", repo: "widget", harness: "claude-code" });
    return new Recorder(
      {
        client: new TrajectoryClient(`http://127.0.0.1:${port}`, "t"),
        spoolDir: dir,
        meta,
        producerId: "rec-1",
        ...overrides,
      },
      new ClaudeCodeReader(),
    );
  }

  it("records a session end to end and reports it drained", async () => {
    const rec = recorder();
    rec.record(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "m" }));
    rec.record(assistantText("hello"));
    const report = await rec.close();

    expect(report.state).toBe("idle");
    expect(rec.drained()).toBe(true);
    // The session was created first, then the events delivered.
    expect(requests[0]!.url).toMatch(/\/sessions$/);
    expect(requests[1]!.body.events!.map((e) => e.kind)).toEqual(["custom", "message"]);
    // Contiguous from 1, which is what makes emitters_ok answerable.
    expect(requests[1]!.body.events!.map((e) => e.producer_seq)).toEqual([1, 2]);
    // #151: and the session does not stay `active` forever. Suspended is the
    // default, because a recorder that was not told the harness finished is
    // not in a position to say it did.
    expect(ended).toEqual(["suspended"]);
  });

  it("records a whole session while ADP is down, and delivers it when ADP returns", async () => {
    // #149's third exit criterion, including the hardest part of it: the
    // server is unreachable at *startup*, so there is no session id to spool
    // against. Recording begins anyway, against a local handle.
    sessionsUp = false;
    const rec = recorder();
    rec.record(assistantText("one"));
    rec.record(assistantText("two"));

    const blocked = await rec.flush();
    expect(blocked.state).toBe("waiting");
    expect(blocked.reason).toContain("no session yet");
    expect(rec.sessionMeta().sessionId).toBeNull();
    // Nothing lost: both events are on disk, numbered.
    expect(rec.drained()).toBe(false);

    sessionsUp = true;
    const report = await rec.close();
    expect(report.state).toBe("idle");
    expect(rec.drained()).toBe(true);
    const appended = requests.filter((r) => r.url.endsWith("/events"));
    expect(appended[0]!.body.events!.map((e) => e.producer_seq)).toEqual([1, 2]);
  });

  it("writes the harness's own session id into the sidecar as soon as it learns it", () => {
    // How someone holding a local transcript finds the ADP session that
    // recorded it — and how `flush` knows what it is finishing.
    const rec = recorder();
    rec.record(JSON.stringify({ type: "system", subtype: "init", session_id: "harness-42", model: "m" }));
    const meta = readSessionMeta(dir, rec.sessionMeta().localId);
    expect(meta!.harnessSessionId).toBe("harness-42");
  });

  it("marks the session with what it refused, in the order it happened", async () => {
    // Backpressure that degrades honestly: the marker goes in *before* the
    // event that finally fit, so the trajectory reads "N refused, then
    // recording resumed" rather than dating the gap one event late.
    const rec = recorder({ maxSpoolBytes: 400 });
    for (let i = 0; i < 60; i += 1) rec.record(assistantText(`m${i}`));
    // Deliver what fitted, which makes room again.
    await rec.flush();
    rec.record(assistantText("after the gap"));
    await rec.close();

    const delivered = requests
      .filter((r) => r.url.endsWith("/events"))
      .flatMap((r) => r.body.events!) as unknown as { kind: string; type: string; payload: { dropped?: number } }[];
    const marker = delivered.find((e) => e.type === "recorder.overflow");
    expect(marker).toBeDefined();
    expect(marker!.payload.dropped).toBeGreaterThan(0);
    // And the event that followed the gap is after the marker, not before it.
    const markerAt = delivered.indexOf(marker!);
    const after = delivered.slice(markerAt + 1).some((e) => JSON.stringify(e).includes("after the gap"));
    expect(after).toBe(true);
  });

  it("leaves a spool a later flush can finish, and says the session ended", async () => {
    // The "survives its shell" contract: the sidecar records that nobody is
    // adding to this spool any more, so `adp-recorder flush` can tell an
    // abandoned session from a live one.
    const rec = recorder();
    rec.record(assistantText("hello"));
    await rec.close();
    const [meta] = listSessions(dir);
    expect(meta!.endedAt).toBeTruthy();
    expect(meta!.sessionId).toBeTruthy();
  });

  it("does not lose the tail of a session when it is closed abruptly", async () => {
    // A tool call still in flight is emitted at close with no status — the
    // call is a fact even when its outcome is not.
    const rec = recorder();
    rec.record(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "sleep 100" } }] },
      }),
    );
    await rec.close();
    const events = requests.filter((r) => r.url.endsWith("/events")).flatMap((r) => r.body.events!);
    expect(events.map((e) => e.kind)).toEqual(["tool_call", "custom"]);
  });
});

describe("tailFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "adp-recorder-tail-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("delivers whole lines only, holding a partial one until it completes", () => {
    // The harness writes one JSON object per line, and half an object is not
    // an event — the same judgement the spool makes about its torn final line.
    const file = path.join(dir, "t.jsonl");
    writeFileSync(file, "");
    const seen: string[] = [];
    const { poll, stop } = tailFile(file, (line) => seen.push(line), { fromStart: true, pollMs: 10_000 });

    appendFileSync(file, '{"a":1}\n{"b":2}\n{"c":');
    poll();
    expect(seen).toEqual(['{"a":1}', '{"b":2}']);

    appendFileSync(file, "3}\n");
    poll();
    expect(seen).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    stop();
  });

  it("starts from the end by default, so attaching mid-session does not replay history", () => {
    const file = path.join(dir, "t.jsonl");
    writeFileSync(file, '{"old":1}\n');
    const seen: string[] = [];
    const { poll, stop } = tailFile(file, (line) => seen.push(line), { pollMs: 10_000 });
    poll();
    expect(seen).toEqual([]);
    appendFileSync(file, '{"new":1}\n');
    poll();
    expect(seen).toEqual(['{"new":1}']);
    stop();
  });

  it("starts over when the file is replaced rather than reading from a stale offset", () => {
    const file = path.join(dir, "t.jsonl");
    writeFileSync(file, '{"first":1}\n{"second":2}\n');
    const seen: string[] = [];
    const { poll, stop } = tailFile(file, (line) => seen.push(line), { fromStart: true, pollMs: 10_000 });
    poll();
    expect(seen).toHaveLength(2);

    // A new session writing to the same path: shorter, and a different
    // document. Reading on from the old offset would splice two sessions.
    writeFileSync(file, '{"fresh":1}\n');
    poll();
    expect(seen[2]).toBe('{"fresh":1}');
    stop();
  });

  it("is quiet about a file that does not exist yet", () => {
    const seen: string[] = [];
    const { poll, stop } = tailFile(path.join(dir, "later.jsonl"), (l) => seen.push(l), { pollMs: 10_000 });
    expect(() => poll()).not.toThrow();
    expect(seen).toEqual([]);
    stop();
  });
});

describe("Spool and reader together", () => {
  it("keeps the reader's kinds inside what the spool will carry", () => {
    // A belt-and-braces pairing of the two halves this package is: whatever
    // the reader invents, the spool must be able to number and store.
    const dir = mkdtempSync(path.join(tmpdir(), "adp-recorder-pair-"));
    const spool = new Spool({ dir, sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
    const reader = new ClaudeCodeReader();
    const events: TrajectoryEvent[] = reader.read(assistantText("x"));
    for (const event of events) expect(spool.append(event).accepted).toBe(true);
    spool.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
