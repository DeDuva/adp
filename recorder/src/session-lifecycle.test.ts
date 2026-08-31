import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { TrajectoryClient } from "./client.js";
import { ClaudeCodeReader } from "./readers/claude-code.js";
import { Recorder } from "./recorder.js";
import { Lifecycle } from "./lifecycle.js";
import { newSessionMeta, producerAlive, readSessionMeta, type SessionMeta } from "./session.js";

const SESSION_ID = "22222222-3333-4444-5555-666666666666";
const RESUMED_ID = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const say = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });

interface Call {
  url: string;
  body: Record<string, unknown>;
}

/**
 * A fake ADP that answers the four lifecycle routes.
 *
 * `resolvable` is the one that earns its place: the real server refuses a
 * checkpoint naming a commit it does not hold, and for a recorder watching a
 * developer's checkout that refusal is the ordinary case rather than an error.
 */
describe("the session lifecycle", () => {
  let server: Server;
  let port: number;
  let calls: Call[];
  let dir: string;
  let resolvable: boolean;
  let resumeWorks: boolean;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        calls.push({ url: req.url!, body });
        const json = (code: number, value: unknown) => {
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify(value));
        };

        if (req.url!.endsWith("/resume")) {
          if (!resumeWorks) return json(422, { message: "session has no checkpoint to resume from" });
          return json(201, { id: RESUMED_ID, harness: body.harness });
        }
        if (req.url!.endsWith("/checkpoints")) {
          if (!resolvable) {
            return json(422, { message: `commit '${body.git_sha}' could not be resolved in this repository` });
          }
          return json(201, { id: "cp-1", seq: 1, git_sha: body.git_sha });
        }
        if (req.url!.endsWith("/close")) return json(200, { id: SESSION_ID, status: body.status });
        if (req.url!.endsWith("/sessions")) return json(201, { id: SESSION_ID, harness: body.harness });
        const events = body.events as { producer_seq: number }[];
        const through = events[events.length - 1]!.producer_seq;
        return json(201, { appended: events.length, duplicates: [], count: through, head: "h", accepted_through: through });
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
    calls = [];
    resolvable = true;
    resumeWorks = true;
    dir = mkdtempSync(path.join(tmpdir(), "adp-lifecycle-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A recorder with a HEAD the test moves, and no real git anywhere. */
  function build(options: { head?: () => string | null; resumeFrom?: string; serverUrl?: string } = {}) {
    const head = options.head ?? (() => SHA_A);
    const lifecycle = new Lifecycle({ dir, headSha: () => head() });
    lifecycle.startedAt(head());
    const meta = newSessionMeta({ dir, owner: "o", repo: "r", harness: "claude-code" });
    const recorder = new Recorder(
      {
        client: new TrajectoryClient(options.serverUrl ?? `http://127.0.0.1:${port}`, "t"),
        spoolDir: dir,
        meta,
        producerId: "test-recorder",
        lifecycle,
        resumeFromSessionId: options.resumeFrom,
      },
      new ClaudeCodeReader(),
    );
    return { recorder, meta, lifecycle };
  }

  const urls = () => calls.map((c) => c.url);
  const bodyOf = (suffix: string) => calls.find((c) => c.url.endsWith(suffix))?.body;

  it("checkpoints when the harness commits, without being asked", () => {
    // The whole of #151's second decision: the value of a checkpoint is that
    // it exists when something goes wrong, which is the moment nobody is
    // thinking about checkpointing.
    let head = SHA_A;
    const { recorder } = build({ head: () => head });
    recorder.record(say("working"));
    head = SHA_B;
    return recorder.flush().then((report) => {
      expect(report.state).toBe("idle");
      expect(urls().some((u) => u.endsWith("/checkpoints"))).toBe(true);
      const cp = bodyOf("/checkpoints")!;
      expect(cp.git_sha).toBe(SHA_B);
      // The harness's own handle is the half a resume actually uses.
      expect(cp.state).toMatchObject({ boundary: "commit", harness: "claude-code", producer_id: "test-recorder" });
    });
  });

  it("takes a final checkpoint and closes on a clean exit", async () => {
    const { recorder } = build();
    recorder.record(say("done"));
    const report = await recorder.close("closed");
    expect(bodyOf("/checkpoints")).toMatchObject({ git_sha: SHA_A, state: { boundary: "final" } });
    expect(bodyOf("/close")).toEqual({ status: "closed" });
    expect(report.notes).toContain("1 checkpoint(s)");
  });

  it("suspends rather than closes when the harness did not finish", async () => {
    // Different facts, and until now the schema could hold the difference
    // while nothing produced it.
    const { recorder, meta } = build();
    recorder.record(say("half"));
    await recorder.close("suspended");
    expect(bodyOf("/close")).toEqual({ status: "suspended" });
    expect(readSessionMeta(dir, meta.localId)).toMatchObject({ outcome: "suspended", terminated: true });
  });

  it("defers a checkpoint whose commit ADP does not have yet, and says why", async () => {
    // They committed and have not pushed. Not an error — a boundary to try
    // again at, and a thing worth telling them.
    resolvable = false;
    const { recorder } = build();
    recorder.record(say("committed locally"));
    const report = await recorder.close("closed");
    expect(report.notes?.join(" ")).toMatch(/not in ADP yet/);
    expect(report.notes).not.toContain("1 checkpoint(s)");
  });

  it("never ends a session over an undelivered spool", async () => {
    // A closed session refuses appends, so ending one here would make the rest
    // of the recording permanently undeliverable — tidying up would destroy
    // the tail. Port 9 is discard: reliably refused, never listening.
    const { recorder, meta } = build({ serverUrl: "http://127.0.0.1:9" });
    recorder.record(say("undelivered"));
    const report = await recorder.close("closed");
    expect(report.state).toBe("waiting");
    const written = readSessionMeta(dir, meta.localId)!;
    expect(written.terminated).toBe(false);
    // The intention survives on disk for `flush` to carry out.
    expect(written.outcome).toBe("closed");
    expect(written.endedAt).toBeTruthy();
    expect(report.notes?.join(" ")).toMatch(/flush' will finish it/);
  });

  it("resumes the session the harness is continuing", async () => {
    const { recorder, meta } = build({ resumeFrom: "prev-session-id" });
    recorder.record(say("continuing"));
    await recorder.close("closed");
    expect(urls().some((u) => u.endsWith("/prev-session-id/resume"))).toBe(true);
    // Events go to the *new* session the resume produced, not the old one.
    expect(urls().some((u) => u.includes(RESUMED_ID))).toBe(true);
    expect(readSessionMeta(dir, meta.localId)).toMatchObject({ resumedFromSessionId: "prev-session-id" });
  });

  it("records anyway when the resume is refused, and reports the gap", async () => {
    // An unlinked recording beats no recording. ADP declines a resume whose
    // checkpoint it cannot verify, or that has none at all, and both are
    // ordinary.
    resumeWorks = false;
    const { recorder } = build({ resumeFrom: "prev-session-id" });
    recorder.record(say("continuing"));
    const report = await recorder.close("closed");
    expect(urls().some((u) => u.endsWith("/sessions"))).toBe(true);
    expect(report.notes?.join(" ")).toMatch(/could not resume prev-session-id/);
    expect(report.delivered).toBe(1);
  });

  it("checkpoints after delivering, never before", async () => {
    // A checkpoint signs the chain head as of that moment. Taken while events
    // sat in the spool it would commit to a head about to move, describing a
    // session shorter than it was.
    const { recorder } = build();
    recorder.record(say("one"));
    await recorder.close("closed");
    const events = calls.findIndex((c) => c.url.endsWith("/events"));
    const checkpoint = calls.findIndex((c) => c.url.endsWith("/checkpoints"));
    expect(events).toBeGreaterThanOrEqual(0);
    expect(checkpoint).toBeGreaterThan(events);
  });
});

describe("producerAlive", () => {
  const base: SessionMeta = {
    localId: "l",
    owner: "o",
    repo: "r",
    harness: "h",
    sessionId: null,
    startedAt: new Date().toISOString(),
  };

  it("does not claim to know about a spool from another machine", () => {
    // A pid from another host means nothing here, and `flush` would rather
    // leave a session active than end one under a live writer.
    expect(producerAlive({ ...base, host: "somewhere-else", pid: 1 })).toBe(false);
  });

  it("does not count this process as the dead recorder's", () => {
    expect(producerAlive({ ...base, host: hostname(), pid: process.pid })).toBe(false);
  });

  it("reports a pid that no longer exists as gone", () => {
    // pid 2^22 is above the default pid_max on Linux, so it cannot be live.
    expect(producerAlive({ ...base, host: hostname(), pid: 4_194_303 })).toBe(false);
  });
});
