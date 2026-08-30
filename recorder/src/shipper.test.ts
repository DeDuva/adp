import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TrajectoryClient } from "./client.js";
import { Shipper } from "./shipper.js";
import { Spool } from "./spool.js";
import type { TrajectoryEvent } from "./events.js";

const SESSION = "11111111-2222-3333-4444-555555555555";

interface RecordedRequest {
  url: string;
  body: { events: { producer_seq: number; client_event_id: string }[]; producer_id: string };
}

function message(text: string): TrajectoryEvent {
  return { kind: "message", type: "assistant", payload: { text } };
}

// A real local HTTP server rather than a mocked fetch, for the reason
// runner/src/client.test.ts gives: this proves the request the shipper
// actually puts on a socket, against the shapes
// server/src/http-rest/sessions.ts really returns.
describe("Shipper", () => {
  let server: Server;
  let port: number;
  let requests: RecordedRequest[];
  let respond: (n: number) => { status: number; body: unknown };
  let dir: string;
  let spool: Spool;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        requests.push({ url: req.url!, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        const { status, body } = respond(requests.length);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
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
    storedThrough = 0;
    dir = mkdtempSync(path.join(tmpdir(), "adp-recorder-ship-"));
    spool = new Spool({ dir, sessionId: SESSION });
  });

  afterEach(() => {
    spool.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function shipper(overrides: Partial<ConstructorParameters<typeof Shipper>[0]> = {}) {
    return new Shipper({
      client: new TrajectoryClient(`http://127.0.0.1:${port}`, "test-token"),
      spool,
      owner: "acme",
      repo: "widget",
      sessionId: SESSION,
      producerId: "recorder-1",
      batchSize: 2,
      backoffMs: 10,
      ...overrides,
    });
  }

  // A server that behaves: `accepted_through` is the highest producer_seq it
  // has been handed, which is what server/src/core/trajectory.ts really
  // returns. Modelling it as a constant is what exposed the drain loop's
  // missing progress check, so it is worth keeping honest here.
  let storedThrough = 0;
  const acceptingServer = () => {
    const batch = requests[requests.length - 1]!.body.events;
    const highest = batch[batch.length - 1]!.producer_seq;
    storedThrough = Math.max(storedThrough, highest);
    return {
      status: 201,
      body: {
        appended: batch.length,
        duplicates: [],
        count: storedThrough,
        head: "abc",
        accepted_through: storedThrough,
      },
    };
  };

  it("delivers in order, in batches, and trusts accepted_through over its own count", () => {
    // The server's mark is what the spool advances on: it is the one that
    // knows what was durably stored.
    for (let i = 0; i < 4; i += 1) spool.append(message(`m${i}`));
    respond = acceptingServer;

    return shipper()
      .drain()
      .then((report) => {
        expect(report.state).toBe("idle");
        expect(requests).toHaveLength(2);
        expect(requests[0]!.body.events.map((e) => e.producer_seq)).toEqual([1, 2]);
        expect(requests[1]!.body.events.map((e) => e.producer_seq)).toEqual([3, 4]);
        expect(requests[0]!.body.producer_id).toBe("recorder-1");
        expect(spool.acknowledged()).toBe(4);
        expect(spool.drained()).toBe(true);
      });
  });

  it("keeps everything and backs off when the server is unreachable", async () => {
    // #149's third Done-when: point it at an unreachable server, restore the
    // server, and the chain is complete. This is the first half — nothing is
    // lost and nothing is acknowledged.
    for (let i = 0; i < 3; i += 1) spool.append(message(`m${i}`));
    const offline = new Shipper({
      client: new TrajectoryClient("http://127.0.0.1:9", "test-token"),
      spool,
      owner: "acme",
      repo: "widget",
      sessionId: SESSION,
      producerId: "recorder-1",
      backoffMs: 10,
    });

    const report = await offline.drain();
    expect(report.state).toBe("waiting");
    expect(report.retryInMs).toBe(10);
    expect(spool.acknowledged()).toBe(0);
    expect(spool.pending()).toHaveLength(3);

    // And the second half: the same spool, a server that answers, everything
    // delivered exactly once.
    respond = acceptingServer;
    const back = await shipper({ batchSize: 10 }).drain();
    expect(back.state).toBe("idle");
    expect(requests[0]!.body.events.map((e) => e.producer_seq)).toEqual([1, 2, 3]);
    expect(spool.drained()).toBe(true);
  });

  it("backs off exponentially, and caps", async () => {
    spool.append(message("m"));
    const offline = new Shipper({
      client: new TrajectoryClient("http://127.0.0.1:9", "test-token"),
      spool,
      owner: "acme",
      repo: "widget",
      sessionId: SESSION,
      producerId: "recorder-1",
      backoffMs: 10,
      maxBackoffMs: 40,
    });
    const delays: number[] = [];
    for (let i = 0; i < 5; i += 1) delays.push((await offline.drain()).retryInMs!);
    expect(delays).toEqual([10, 20, 40, 40, 40]);
  });

  it("replays from where the server says, when it reports a gap", async () => {
    // A lost acknowledgement leaves the two sides disagreeing about what was
    // stored. The server's number wins, and the overlap is harmless because
    // client_event_id makes a re-send a reported duplicate rather than a
    // second append.
    for (let i = 0; i < 4; i += 1) spool.append(message(`m${i}`));
    spool.acknowledge(3);

    respond = (n) =>
      n === 1
        ? { status: 409, body: { message: "producer_seq 4 is not contiguous", expected_next_seq: 2 } }
        : { status: 201, body: { appended: 3, duplicates: ["dup"], count: 4, head: "abc", accepted_through: 4 } };


    const report = await shipper({ batchSize: 10 }).drain();
    expect(report.state).toBe("idle");
    expect(requests[0]!.body.events.map((e) => e.producer_seq)).toEqual([4]);
    // Rewound to what the server asked for, then replayed from there.
    expect(requests[1]!.body.events.map((e) => e.producer_seq)).toEqual([2, 3, 4]);
    expect(report.duplicates).toBe(1);
    expect(spool.acknowledged()).toBe(4);
  });

  it("quarantines on a refusal instead of retrying it forever", async () => {
    // A 422 does not become true by waiting — an oversized payload, or a
    // secret under `on_secret: refuse`. Retrying it in a loop would turn this
    // process into a denial-of-service against the server it records into.
    spool.append(message("m"));
    respond = () => ({ status: 422, body: { message: "Validation failed" } });

    const ship = shipper();
    const report = await ship.drain();
    expect(report.state).toBe("quarantined");
    expect(report.reason).toContain("422");
    expect(ship.quarantined()).toBe(true);

    // **Quarantine is not a drop.** The events are still on disk, unacknowledged.
    expect(spool.acknowledged()).toBe(0);
    expect(spool.pending()).toHaveLength(1);

    // And it stops asking.
    await ship.drain();
    expect(requests).toHaveLength(1);
  });

  it("treats a storage-quota refusal as retryable, because an operator can clear it", async () => {
    // 403 from the org byte ceiling is the one refusal that resolves without
    // anyone touching this process. Quarantining it would strand a session
    // that was about to be fine.
    spool.append(message("m"));
    respond = () => ({ status: 403, body: { message: "org storage quota exceeded" } });
    const report = await shipper().drain();
    expect(report.state).toBe("waiting");
    expect(spool.pending()).toHaveLength(1);
  });

  it("does not stall when the server reports the session as untracked", async () => {
    // accepted_through is null only if something else appended to this session
    // without a counter. Falling back to the batch's own last number keeps the
    // spool moving instead of re-sending the same batch forever.
    spool.append(message("m"));
    respond = () => ({
      status: 201,
      body: { appended: 1, duplicates: [], count: 1, head: "abc", accepted_through: null },
    });
    const report = await shipper().drain();
    expect(report.state).toBe("idle");
    expect(spool.acknowledged()).toBe(1);
  });

  it("stops instead of looping when an accepted batch does not move the mark", async () => {
    // Found by a test that modelled a server whose `accepted_through` stood
    // still: `drain` continues while batches succeed, so a 201 that never
    // advances would have this re-sending the same batch at full speed
    // forever — a denial-of-service we would be aiming at our own server.
    for (let i = 0; i < 4; i += 1) spool.append(message(`m${i}`));
    respond = () => ({
      status: 201,
      body: { appended: 2, duplicates: [], count: 2, head: "abc", accepted_through: 2 },
    });

    const report = await shipper({ batchSize: 2 }).drain();
    expect(report.state).toBe("quarantined");
    expect(report.reason).toContain("did not advance");
    // One batch that made progress, one that did not, and then it stopped.
    expect(requests).toHaveLength(2);
    // Nothing was discarded to get out of the loop.
    expect(spool.pending()).toHaveLength(2);
  });

  it("stops instead of looping when the server asks to replay from the same place twice", async () => {
    // The same failure through the other door. Obeying a replay instruction
    // once is recovery; obeying the identical one again is a loop.
    for (let i = 0; i < 3; i += 1) spool.append(message(`m${i}`));
    respond = () => ({ status: 409, body: { message: "not contiguous", expected_next_seq: 1 } });

    const report = await shipper({ batchSize: 10 }).drain();
    expect(report.state).toBe("quarantined");
    expect(report.reason).toContain("replay from producer_seq 1");
    expect(requests).toHaveLength(2);
    expect(spool.pending()).toHaveLength(3);
  });

  it("survives the recorder dying mid-session: a new one finishes the job", async () => {
    // #149's second Done-when. The first shipper delivers half and the process
    // "dies"; a new Spool and a new Shipper over the same directory deliver
    // the rest, and the server sees one contiguous run with no duplicates.
    for (let i = 0; i < 4; i += 1) spool.append(message(`m${i}`));
    // The first recorder delivers one batch and then "dies": the second batch
    // meets a server that has gone away, so nothing past 2 is acknowledged.
    respond = (n) => (n === 1 ? acceptingServer() : { status: 503, body: { message: "gone" } });
    await shipper({ batchSize: 2 }).drain();
    spool.close();

    const resumed = new Spool({ dir, sessionId: SESSION });
    expect(resumed.acknowledged()).toBe(2);
    requests = [];
    respond = acceptingServer;
    const report = await new Shipper({
      client: new TrajectoryClient(`http://127.0.0.1:${port}`, "test-token"),
      spool: resumed,
      owner: "acme",
      repo: "widget",
      sessionId: SESSION,
      producerId: "recorder-2",
      batchSize: 10,
    }).drain();

    expect(report.state).toBe("idle");
    // Exactly the undelivered remainder, in order, with no repeat of 1-2.
    expect(requests[0]!.body.events.map((e) => e.producer_seq)).toEqual([3, 4]);
    expect(resumed.drained()).toBe(true);
    resumed.close();
  });
});
