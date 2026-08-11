import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { skipWithoutDocker } from "../test/require-docker.js";
import { buildCreateArgs, runGateJob } from "./docker.js";

describe("buildCreateArgs", () => {
  const job = { id: "job-1", image: "busybox:1", command: "echo hi", timeoutMs: 5000 };
  const limits = { memory: "256m", cpus: "1" };

  it("names the container after the job id, for a timeout's docker kill/rm to find it", () => {
    expect(buildCreateArgs(job, limits)).toContain("adp-gate-job-1");
  });

  it("denies network by default", () => {
    const args = buildCreateArgs(job, limits);
    expect(args).toContain("--network");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
  });

  it("applies the memory and cpu caps", () => {
    const args = buildCreateArgs(job, limits);
    expect(args[args.indexOf("--memory") + 1]).toBe("256m");
    expect(args[args.indexOf("--cpus") + 1]).toBe("1");
  });

  it("sets the checkout's working directory", () => {
    const args = buildCreateArgs(job, limits);
    expect(args[args.indexOf("-w") + 1]).toBe("/workspace");
  });

  it("never mounts a host path or injects an env var — the isolation bar is what's absent here", () => {
    const args = buildCreateArgs(job, limits);
    expect(args).not.toContain("-v");
    expect(args).not.toContain("--volume");
    expect(args).not.toContain("-e");
    expect(args).not.toContain("--env");
    expect(args).not.toContain("--env-file");
  });

  it("runs the job's own command via a shell inside the named image, not composed into a single string beforehand", () => {
    const args = buildCreateArgs(job, limits);
    expect(args.slice(-4)).toEqual(["busybox:1", "sh", "-c", "echo hi"]);
  });
});

// The seam this whole package exists for: real `docker create`/`cp`/`start`,
// not a mocked child process. A fake could assert on the arguments this file
// builds without ever proving they cause the daemon to actually deny
// network access, cap memory, materialize a checkout without a bind mount,
// or die on schedule.
describe.skipIf(skipWithoutDocker)("runGateJob (real docker)", () => {
  const limits = { memory: "128m", cpus: "1" };
  let checkoutDirs: string[] = [];

  async function emptyCheckout(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "adp-runner-docker-test-"));
    checkoutDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(checkoutDirs.map((d) => rm(d, { recursive: true, force: true })));
    checkoutDirs = [];
  });

  it("reports the container's real exit code and captured output on success", async () => {
    const result = await runGateJob(
      { id: `t-${Date.now()}-a`, image: "busybox:1", command: "echo hello-from-container", timeoutMs: 15000 },
      limits,
      await emptyCheckout(),
    );
    expect(result).toMatchObject({ status: "succeeded", exitCode: 0 });
    expect(result.logs).toContain("hello-from-container");
  }, 30000);

  it("reports a non-zero exit as failed, not an error", async () => {
    const result = await runGateJob(
      { id: `t-${Date.now()}-b`, image: "busybox:1", command: "exit 7", timeoutMs: 15000 },
      limits,
      await emptyCheckout(),
    );
    expect(result).toMatchObject({ status: "failed", exitCode: 7 });
  }, 30000);

  it("really cannot reach the network — proves --network none took effect against the daemon, not just the argument list", async () => {
    const result = await runGateJob(
      {
        id: `t-${Date.now()}-c`,
        image: "busybox:1",
        command: "wget -T 3 -O- http://example.com || echo NETWORK_BLOCKED",
        timeoutMs: 15000,
      },
      limits,
      await emptyCheckout(),
    );
    expect(result.status).toBe("succeeded");
    expect(result.logs).toContain("NETWORK_BLOCKED");
  }, 30000);

  it("kills a container that outlives its timeout, and reports timed_out rather than whatever exit code the kill produced", async () => {
    const result = await runGateJob(
      { id: `t-${Date.now()}-d`, image: "busybox:1", command: "sleep 30", timeoutMs: 2000 },
      limits,
      await emptyCheckout(),
    );
    expect(result.status).toBe("timed_out");
    expect(result.exitCode).toBeNull();
  }, 30000);

  it("fails fast (no network pull attempt) on a syntactically invalid image reference", async () => {
    // Uppercase is invalid in a Docker image reference — the CLI rejects
    // this locally, so the test stays fast and network-independent rather
    // than depending on how a real registry answers a missing-image pull.
    const result = await runGateJob(
      { id: `t-${Date.now()}-e`, image: "Invalid_Image_Reference", command: "true", timeoutMs: 15000 },
      limits,
      await emptyCheckout(),
    );
    expect(result.status).toBe("failed");
    expect(result.exitCode).not.toBe(0);
  }, 30000);

  // The property M4-9c actually adds: a checkout materializes inside the
  // container without a host mount. `docker cp`, not `-v` — proven by
  // writing a real file into checkoutDir on the host and reading it back
  // from inside a real, isolated container.
  it("makes the checkout's files visible inside the container at /workspace, via docker cp rather than a bind mount", async () => {
    const dir = await emptyCheckout();
    await writeFile(path.join(dir, "marker.txt"), "checked-out-content");

    const result = await runGateJob(
      { id: `t-${Date.now()}-f`, image: "busybox:1", command: "pwd && cat marker.txt", timeoutMs: 15000 },
      limits,
      dir,
    );
    expect(result.status).toBe("succeeded");
    expect(result.logs).toContain("/workspace");
    expect(result.logs).toContain("checked-out-content");
  }, 30000);

  it("cleans up a created container even when docker cp fails, rather than leaking it", async () => {
    const id = `t-${Date.now()}-g`;
    const result = await runGateJob({ id, image: "busybox:1", command: "true", timeoutMs: 15000 }, limits, "/nonexistent-checkout-dir");
    expect(result.status).toBe("error");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("docker", ["ps", "-a", "--filter", `name=adp-gate-${id}`, "--format", "{{.Names}}"]);
    expect(stdout.trim()).toBe("");
  }, 30000);
});
