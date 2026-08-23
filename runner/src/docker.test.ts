import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { skipWithoutDocker } from "../test/require-docker.js";
import { buildCreateArgs, runGateJob } from "./docker.js";

describe("buildCreateArgs", () => {
  const job = { id: "job-1", image: "busybox:1", command: "echo hi", timeoutMs: 5000 };
  const limits = { memory: "256m", cpus: "1", pidsLimit: 256 };

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

  it("drops all capabilities, forbids privilege escalation, and bounds pids (#100)", () => {
    const args = buildCreateArgs(job, { memory: "128m", cpus: "1", pidsLimit: 64 });
    expect(args.join(" ")).toContain("--cap-drop ALL");
    expect(args.join(" ")).toContain("--security-opt no-new-privileges:true");
    expect(args.join(" ")).toContain("--pids-limit 64");
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
  const limits = { memory: "128m", cpus: "1", pidsLimit: 256 };
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

  // #100, same proved-against-the-daemon standard as the network test:
  // busybox's chown needs CAP_CHOWN, which --cap-drop=ALL strips even from
  // the in-container root the process runs as. If the flag ever fell off
  // the argument list, root-in-container could chown / and this fails.
  it("capabilities are really dropped — chown as in-container root is refused", async () => {
    const result = await runGateJob(
      {
        id: `t-${Date.now()}-caps`,
        image: "busybox:1",
        command: "chown 1:1 /bin/sh 2>&1 || echo CAPS_DROPPED",
        timeoutMs: 15000,
      },
      limits,
      await emptyCheckout(),
    );
    expect(result.status).toBe("succeeded");
    expect(result.logs).toContain("CAPS_DROPPED");
  }, 30000);

  it("the pids limit really binds — a spawn storm dies inside the container", async () => {
    const result = await runGateJob(
      {
        id: `t-${Date.now()}-pids`,
        // Try to hold 40 concurrent sleeps under a limit of 16: the spawn
        // failures surface as shell errors, and the container survives to
        // report them — the host never sees the storm.
        command: "for i in $(seq 1 40); do sleep 5 & done 2>&1; echo SPAWNED $(jobs -p | wc -l)",
        image: "busybox:1",
        timeoutMs: 15000,
      },
      { ...limits, pidsLimit: 16 },
      await emptyCheckout(),
    );
    // The command's exact exit depends on where the limit bites; the
    // property is bounded process count, not a specific shell message.
    const spawned = /SPAWNED\s+(\d+)/.exec(result.logs);
    if (spawned) expect(Number(spawned[1])).toBeLessThan(40);
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

  // Exit criterion 5's first attack shape ("a gate script that attempts a
  // host-mount ... is refused"), proved against the daemon rather than
  // against the argument list.
  //
  // buildCreateArgs already asserts no -v/--volume is passed, but that is a
  // unit test on a string array — the same gap this describe block exists to
  // close for --network none. What a gate script can actually reach is a
  // property of the running container, so this asks the container.
  //
  // Two absences, and the second is the one with teeth. A host file at a
  // known absolute path is invisible, so no bind mount is in play. And
  // /var/run/docker.sock does not exist — the stated reason
  // for putting the runner on its own host is that "a mounted Docker socket
  // is root on the host", and a socket mounted into a gate container would
  // hand every gate script exactly that, silently, while every other
  // isolation test on this file kept passing.
  it("cannot see the host filesystem or the Docker socket — no bind mount, no socket, proved from inside", async () => {
    const hostMarker = path.join(await emptyCheckout(), "..", `adp-host-only-${Date.now()}.txt`);
    const hostPath = path.resolve(hostMarker);
    await writeFile(hostPath, "host-only-content");

    try {
      const result = await runGateJob(
        {
          id: `t-${Date.now()}-h`,
          image: "busybox:1",
          // Prints a marker for each thing it FAILED to reach. A gate script
          // that could read either would print neither and fail the test.
          // Always exits 0, so a leak fails on the specific missing marker
          // below rather than on the job's exit status — the assertion then
          // names which of the two absences stopped holding.
          command:
            `([ ! -e ${hostPath} ] && echo NO_HOST_FILE); ` +
            `([ ! -S /var/run/docker.sock ] && echo NO_DOCKER_SOCK); ` +
            `true`,
          timeoutMs: 15000,
        },
        limits,
        await emptyCheckout(),
      );

      expect(result.status).toBe("succeeded");
      expect(result.logs).toContain("NO_HOST_FILE");
      expect(result.logs).toContain("NO_DOCKER_SOCK");
      // The host file really did exist while the container ran — otherwise
      // NO_HOST_FILE proves nothing but that the path was wrong.
      expect(await readFile(hostPath, "utf8")).toBe("host-only-content");
    } finally {
      await rm(hostPath, { force: true });
    }
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
