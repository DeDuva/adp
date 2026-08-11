import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { GateJobClient } from "./client.js";
import { loadConfig } from "./config.js";
import { pollOnce } from "./main.js";
import type { GateJobSpec, RunnerLimits, ExecutionResult } from "./docker.js";

interface RecordedRequest {
  method: string;
  url: string;
  body: string;
}

// pollOnce's own job is wiring, not execution or transport — those are
// docker.test.ts's and client.test.ts's jobs respectively. This proves a
// claimed job's fields reach the (injected, fake) executor correctly, and
// that executor's result reaches /complete under the claimed job's own id —
// with no real Docker daemon or claim logic needed to prove that wiring.
describe("pollOnce", () => {
  let server: Server;
  let port: number;
  let requests: RecordedRequest[];
  let claimResponse: { status: number; body: unknown };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push({ method: req.method!, url: req.url!, body });

        if (req.url === "/api/adp/gate-jobs/claim") {
          res.writeHead(claimResponse.status, { "Content-Type": "application/json" });
          res.end(claimResponse.status === 204 ? undefined : JSON.stringify(claimResponse.body));
          return;
        }
        // /complete
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
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
    claimResponse = { status: 204, body: null };
  });

  function fakeConfig() {
    return loadConfig({
      ADP_SERVER_URL: `http://127.0.0.1:${port}`,
      ADP_RUNNER_TOKEN: "adp_pat_test",
      RUNNER_ID: "test-runner-1",
    });
  }

  it("returns false and calls neither run nor complete when nothing is queued", async () => {
    let ran = false;
    const client = new GateJobClient(`http://127.0.0.1:${port}`, "adp_pat_test");
    const result = await pollOnce(client, fakeConfig(), async () => {
      ran = true;
      return { status: "succeeded", exitCode: 0, logs: "" };
    });

    expect(result).toBe(false);
    expect(ran).toBe(false);
    expect(requests).toHaveLength(1); // just the claim
  });

  it("runs a claimed job with its own image/command/timeout and limits from config, then completes it", async () => {
    claimResponse = {
      status: 200,
      body: {
        id: "job-42",
        repo_id: "repo-1",
        git_sha: "a".repeat(40),
        name: "unit",
        image: "node:22",
        command: "npm test",
        timeout_ms: 60000,
        status: "running",
        claimed_by: "test-runner-1",
      },
    };

    let seenJob: GateJobSpec | undefined;
    let seenLimits: RunnerLimits | undefined;
    const fakeRun = async (job: GateJobSpec, limits: RunnerLimits): Promise<ExecutionResult> => {
      seenJob = job;
      seenLimits = limits;
      return { status: "succeeded", exitCode: 0, logs: "all good\n" };
    };

    const client = new GateJobClient(`http://127.0.0.1:${port}`, "adp_pat_test");
    const config = fakeConfig();
    const result = await pollOnce(client, config, fakeRun);

    expect(result).toBe(true);
    expect(seenJob).toEqual({ id: "job-42", image: "node:22", command: "npm test", timeoutMs: 60000 });
    expect(seenLimits).toEqual({ memory: config.RUNNER_MEMORY, cpus: config.RUNNER_CPUS });

    const completeReq = requests.find((r) => r.url === "/api/adp/gate-jobs/job-42/complete");
    expect(completeReq).toBeDefined();
    expect(JSON.parse(completeReq!.body)).toEqual({ status: "succeeded", exit_code: 0, logs: "all good\n" });
  });
});
