import { describe, it, expect } from "vitest";
import { skipWithoutDocker } from "../test/require-docker.js";
import { buildDockerArgs, runGateJob } from "./docker.js";

describe("buildDockerArgs", () => {
  const job = { id: "job-1", image: "busybox:1", command: "echo hi", timeoutMs: 5000 };
  const limits = { memory: "256m", cpus: "1" };

  it("names the container after the job id, for a timeout's docker kill to find it", () => {
    expect(buildDockerArgs(job, limits)).toContain("adp-gate-job-1");
  });

  it("denies network by default", () => {
    const args = buildDockerArgs(job, limits);
    expect(args).toContain("--network");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
  });

  it("applies the memory and cpu caps", () => {
    const args = buildDockerArgs(job, limits);
    expect(args[args.indexOf("--memory") + 1]).toBe("256m");
    expect(args[args.indexOf("--cpus") + 1]).toBe("1");
  });

  it("never mounts a host path or injects an env var — the isolation bar is what's absent here", () => {
    const args = buildDockerArgs(job, limits);
    expect(args).not.toContain("-v");
    expect(args).not.toContain("--volume");
    expect(args).not.toContain("-e");
    expect(args).not.toContain("--env");
    expect(args).not.toContain("--env-file");
  });

  it("runs the job's own command via a shell inside the named image, not composed into a single string beforehand", () => {
    const args = buildDockerArgs(job, limits);
    expect(args.slice(-4)).toEqual(["busybox:1", "sh", "-c", "echo hi"]);
  });
});

// The seam this whole package exists for: real `docker run`, not a mocked
// child process. A fake could assert on the arguments this file builds
// without ever proving they cause the daemon to actually deny network
// access, cap memory, or die on schedule.
describe.skipIf(skipWithoutDocker)("runGateJob (real docker)", () => {
  const limits = { memory: "128m", cpus: "1" };

  it("reports the container's real exit code and captured output on success", async () => {
    const result = await runGateJob(
      { id: `t-${Date.now()}-a`, image: "busybox:1", command: "echo hello-from-container", timeoutMs: 15000 },
      limits,
    );
    expect(result).toMatchObject({ status: "succeeded", exitCode: 0 });
    expect(result.logs).toContain("hello-from-container");
  }, 30000);

  it("reports a non-zero exit as failed, not an error", async () => {
    const result = await runGateJob({ id: `t-${Date.now()}-b`, image: "busybox:1", command: "exit 7", timeoutMs: 15000 }, limits);
    expect(result).toMatchObject({ status: "failed", exitCode: 7 });
  }, 30000);

  it("really cannot reach the network — proves --network none took effect against the daemon, not just the argument list", async () => {
    const result = await runGateJob(
      { id: `t-${Date.now()}-c`, image: "busybox:1", command: "wget -T 3 -O- http://example.com || echo NETWORK_BLOCKED", timeoutMs: 15000 },
      limits,
    );
    expect(result.status).toBe("succeeded");
    expect(result.logs).toContain("NETWORK_BLOCKED");
  }, 30000);

  it("kills a container that outlives its timeout, and reports timed_out rather than whatever exit code the kill produced", async () => {
    const result = await runGateJob({ id: `t-${Date.now()}-d`, image: "busybox:1", command: "sleep 30", timeoutMs: 2000 }, limits);
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
    );
    expect(result.status).toBe("failed");
    expect(result.exitCode).not.toBe(0);
  }, 30000);
});
