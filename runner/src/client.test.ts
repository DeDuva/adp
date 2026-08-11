import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { GateJobClient } from "./client.js";

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

// A real local HTTP server, not a mocked fetch — same boundary
// cli/test/cli.test.ts exercises for the same reason: this proves the actual
// request GateJobClient sends (method, path, auth header, body shape) over a
// real socket, matching server/src/http-rest/gate-jobs.ts's real routes.
describe("GateJobClient", () => {
  let server: Server;
  let port: number;
  let requests: RecordedRequest[];
  let nextResponse: { status: number; body: unknown };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        requests.push({
          method: req.method!,
          url: req.url!,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        if (Buffer.isBuffer(nextResponse.body)) {
          res.writeHead(nextResponse.status, { "Content-Type": "application/x-tar" });
          res.end(nextResponse.body);
          return;
        }
        res.writeHead(nextResponse.status, { "Content-Type": "application/json" });
        res.end(nextResponse.status === 204 ? undefined : JSON.stringify(nextResponse.body));
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
    nextResponse = { status: 200, body: {} };
  });

  function client(): GateJobClient {
    return new GateJobClient(`http://127.0.0.1:${port}`, "adp_pat_runner-token");
  }

  it("claim posts claimed_by with the bearer token, and returns the parsed job", async () => {
    nextResponse = { status: 200, body: { id: "job-1", status: "running" } };
    const job = await client().claim("runner-host-1");

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe("/api/adp/gate-jobs/claim");
    expect(requests[0]!.headers.authorization).toBe("Bearer adp_pat_runner-token");
    expect(JSON.parse(requests[0]!.body)).toEqual({ claimed_by: "runner-host-1" });
    expect(job).toEqual({ id: "job-1", status: "running" });
  });

  it("claim returns null on 204 — nothing queued is not an error", async () => {
    nextResponse = { status: 204, body: null };
    const job = await client().claim("runner-host-1");
    expect(job).toBeNull();
  });

  it("claim throws on a non-2xx, non-204 response", async () => {
    nextResponse = { status: 500, body: { message: "boom" } };
    await expect(client().claim("runner-host-1")).rejects.toThrow(/500/);
  });

  it("complete posts status/exit_code/logs to the job's own id", async () => {
    nextResponse = { status: 200, body: { id: "job-1", status: "succeeded" } };
    await client().complete("job-1", { status: "succeeded", exitCode: 0, logs: "ok\n" });

    expect(requests[0]!.url).toBe("/api/adp/gate-jobs/job-1/complete");
    expect(JSON.parse(requests[0]!.body)).toEqual({ status: "succeeded", exit_code: 0, logs: "ok\n" });
  });

  it("complete throws on a non-2xx response", async () => {
    nextResponse = { status: 409, body: { message: "not running" } };
    await expect(client().complete("job-1", { status: "succeeded", exitCode: 0, logs: "" })).rejects.toThrow(/409/);
  });

  it("checkout GETs the job's own id and returns the raw response bytes", async () => {
    nextResponse = { status: 200, body: Buffer.from("not really a tar, just bytes") };
    const tar = await client().checkout("job-1");

    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.url).toBe("/api/adp/gate-jobs/job-1/checkout");
    expect(requests[0]!.headers.authorization).toBe("Bearer adp_pat_runner-token");
    expect(tar.toString("utf8")).toBe("not really a tar, just bytes");
  });

  it("checkout throws on a non-2xx response", async () => {
    nextResponse = { status: 409, body: { message: "not currently claimed" } };
    await expect(client().checkout("job-1")).rejects.toThrow(/409/);
  });
});
