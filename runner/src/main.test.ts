import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GateJobClient } from "./client.js";
import { loadConfig } from "./config.js";
import { pollOnce } from "./main.js";
import type { GateJobSpec, RunnerLimits, ExecutionResult } from "./docker.js";

const execFileAsync = promisify(execFile);

interface RecordedRequest {
  method: string;
  url: string;
  body: string;
}

async function buildCheckoutTar(): Promise<Buffer> {
  const srcDir = await mkdtemp(path.join(tmpdir(), "adp-runner-main-test-fixture-"));
  try {
    await writeFile(path.join(srcDir, "marker.txt"), "from-checkout");
    const { stdout } = await execFileAsync("tar", ["-cf", "-", "-C", srcDir, "marker.txt"], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout as unknown as Buffer;
  } finally {
    await rm(srcDir, { recursive: true, force: true });
  }
}

// pollOnce's own job is wiring, not execution or transport — those are
// docker.test.ts's and client.test.ts's jobs respectively. This proves a
// claimed job's fields (and its real, materialized checkout — checkout.ts
// runs for real here, unfaked) reach the injected executor correctly, that
// the checkout directory is cleaned up afterward, and that the executor's
// result reaches /complete under the claimed job's own id — with no real
// Docker daemon or claim logic needed to prove any of that wiring.
describe("pollOnce", () => {
  let server: Server;
  let port: number;
  let requests: RecordedRequest[];
  let claimResponse: { status: number; body: unknown };
  let checkoutTar: Buffer;

  beforeAll(async () => {
    checkoutTar = await buildCheckoutTar();

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
        if (req.url?.endsWith("/checkout")) {
          res.writeHead(200, { "Content-Type": "application/x-tar" });
          res.end(checkoutTar);
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

  it("returns false and calls neither checkout, run, nor complete when nothing is queued", async () => {
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

  it("materializes the claimed job's real checkout, runs it with the right image/command/timeout and config limits, completes it, then cleans up the checkout dir", async () => {
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
    let seenCheckoutDir: string | undefined;
    const fakeRun = async (job: GateJobSpec, limits: RunnerLimits, checkoutDir: string): Promise<ExecutionResult> => {
      seenJob = job;
      seenLimits = limits;
      seenCheckoutDir = checkoutDir;
      // The real checkout.ts extraction, not a fake — proves pollOnce wires
      // client.checkout()'s bytes through materializeCheckout before run().
      const marker = await import("node:fs/promises").then((fs) => fs.readFile(path.join(checkoutDir, "marker.txt"), "utf8"));
      expect(marker).toBe("from-checkout");
      return { status: "succeeded", exitCode: 0, logs: "all good\n" };
    };

    const client = new GateJobClient(`http://127.0.0.1:${port}`, "adp_pat_test");
    const config = fakeConfig();
    const result = await pollOnce(client, config, fakeRun);

    expect(result).toBe(true);
    expect(seenJob).toEqual({ id: "job-42", image: "node:22", command: "npm test", timeoutMs: 60000 });
    expect(seenLimits).toEqual({
      memory: config.RUNNER_MEMORY,
      cpus: config.RUNNER_CPUS,
      pidsLimit: config.RUNNER_PIDS_LIMIT,
    });
    expect(requests.some((r) => r.url === "/api/adp/gate-jobs/job-42/checkout")).toBe(true);

    const completeReq = requests.find((r) => r.url === "/api/adp/gate-jobs/job-42/complete");
    expect(completeReq).toBeDefined();
    expect(JSON.parse(completeReq!.body)).toEqual({ status: "succeeded", exit_code: 0, logs: "all good\n" });

    // Cleaned up after the cycle, not left behind for every future job to
    // accumulate on disk.
    await expect(stat(seenCheckoutDir!)).rejects.toThrow();
  });

  // #100: the gate image is repo-controlled (any pushed adp.yaml names
  // one), so the host operator's allowlist gets the last word. Refused
  // before checkout — the job's code never even lands on this host — and
  // completed as a terminal error, not abandoned to the reaper's retry cap.
  it("refuses a non-allowlisted image before fetching the checkout, completing the job as error", async () => {
    claimResponse = {
      status: 200,
      body: {
        id: "job-43",
        repo_id: "repo-1",
        git_sha: "a".repeat(40),
        name: "unit",
        image: "ghcr.io/evil/backdoor:latest",
        command: "true",
        timeout_ms: 60000,
        status: "running",
        claimed_by: "test-runner-1",
      },
    };

    let ran = false;
    const client = new GateJobClient(`http://127.0.0.1:${port}`, "adp_pat_test");
    const config = loadConfig({
      ADP_SERVER_URL: `http://127.0.0.1:${port}`,
      ADP_RUNNER_TOKEN: "adp_pat_test",
      RUNNER_ID: "test-runner-1",
      RUNNER_IMAGE_ALLOWLIST: "busybox:1, node:22",
    });
    const result = await pollOnce(client, config, async () => {
      ran = true;
      return { status: "succeeded", exitCode: 0, logs: "" };
    });

    expect(result).toBe(true);
    expect(ran).toBe(false);
    expect(requests.some((r) => r.url === "/api/adp/gate-jobs/job-43/checkout")).toBe(false);
    const completeReq = requests.find((r) => r.url === "/api/adp/gate-jobs/job-43/complete");
    expect(completeReq).toBeDefined();
    const body = JSON.parse(completeReq!.body) as { status: string; logs: string };
    expect(body.status).toBe("error");
    expect(body.logs).toContain("RUNNER_IMAGE_ALLOWLIST");
  });
});
