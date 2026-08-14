import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Same ceiling http-rest/gate-jobs.ts's CompleteBody enforces on the server
// side — truncated here too, so a runaway container's output gets reported
// as a useful (truncated) tail instead of the completion call itself being
// rejected with a 422 over an oversized body.
const LOG_BYTE_LIMIT = 1_000_000;

// Where a checkout (runner/src/checkout.ts) lands inside the container, and
// the working directory the job's own command runs from.
const WORKDIR = "/workspace";

export interface GateJobSpec {
  id: string;
  image: string;
  command: string;
  timeoutMs: number;
}

export interface RunnerLimits {
  memory: string;
  cpus: string;
  pidsLimit: number;
}

export interface ExecutionResult {
  status: "succeeded" | "failed" | "timed_out" | "error";
  exitCode: number | null;
  logs: string;
}

function containerNameFor(jobId: string): string {
  return `adp-gate-${jobId}`;
}

interface ExecError {
  code?: number;
  stderr?: string | Buffer;
  message?: string;
}

function execErrorInfo(err: unknown): { exitCode: number | null; message: string } {
  const e = (err ?? {}) as ExecError;
  const exitCode = typeof e.code === "number" ? e.code : null;
  const stderrText = e.stderr ? e.stderr.toString() : "";
  return { exitCode, message: (stderrText || e.message || String(err)).slice(0, LOG_BYTE_LIMIT) };
}

// The isolation bar this executor exists to enforce (pragmatic_mvp.md
// §4.5/§4.7): network-deny by default, no host mounts, no ambient secrets,
// CPU/memory caps. Each is an *absence* from this argument list — there is
// no `-v` (no host mounts: the checkout arrives via `docker cp`, a
// daemon-mediated file copy, not a live window into the host filesystem) and
// no `-e`/`--env-file` (no ambient secrets — `docker create` never forwards
// the host's own environment into a container unless told to). Per-job
// network allowlisting from `adp.yaml` is not built yet; this executor is
// deliberately adp.yaml-agnostic regardless — it only ever sees the
// image/command a gate_jobs row already carries.
export function buildCreateArgs(job: GateJobSpec, limits: RunnerLimits): string[] {
  return [
    "create",
    "--rm",
    "--name",
    containerNameFor(job.id),
    "--network",
    "none",
    "--memory",
    limits.memory,
    "--cpus",
    limits.cpus,
    // #100: the rest of the cage. --pids-limit bounds a fork bomb to the
    // container. --cap-drop=ALL strips every Linux capability — a gate
    // script has no business with CAP_SYS_ADMIN, CAP_NET_RAW, or any other
    // escape primitive; docker's default grant exists for images that act
    // like tiny systems, and a gate is a command. no-new-privileges pins
    // that down: nothing in the container (setuid binaries included) can
    // gain privileges the process didn't start with.
    //
    // Deliberately still absent, each blocked by the docker-cp checkout
    // design rather than forgotten: --read-only (gates build INTO the
    // checkout at WORKDIR, which lives on the rootfs; a tmpfs there would
    // shadow the checkout `docker cp` placed before start), --user (the
    // cp'd checkout is root-owned inside the container, so a non-root user
    // can't write the tree it is supposed to build), and a storage cap
    // (--storage-opt size requires a pquota-mounted overlay2 backing store
    // and hard-errors on the default ext4). Revisit all three together if
    // the checkout ever moves to a volume.
    "--pids-limit",
    String(limits.pidsLimit),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "-w",
    WORKDIR,
    job.image,
    "sh",
    "-c",
    job.command,
  ];
}

// Killing the spawned `docker start` client process is not enough on its
// own — the container keeps running detached from that client — so a
// timeout has to reach the daemon directly by the name we gave it.
async function killContainer(name: string): Promise<void> {
  try {
    await execFileAsync("docker", ["kill", name]);
  } catch {
    // Lost the race: the container had already exited on its own between the
    // timeout firing and this running. Not an error.
  }
}

// `docker create`'s `--rm` only removes the container once it actually runs
// and exits (via `start`) — a container that was created but never started
// (a `docker cp` failure in between) would otherwise leak.
async function removeContainer(name: string): Promise<void> {
  try {
    await execFileAsync("docker", ["rm", "-f", name]);
  } catch {
    // Never existed, or already gone — fine either way.
  }
}

// "Materializes a checkout, runs commands" (pragmatic_mvp.md's gate-runner
// design) as two literal, separate steps: `docker create` (the isolated
// container, not yet running) + `docker cp` (checkoutDir's contents in,
// daemon-mediated, no bind mount) + `docker start -a` (run it, wall-clock
// bounded). checkoutDir is produced by runner/src/checkout.ts from the
// server's `/gate-jobs/{id}/checkout` tarball — this function never talks to
// git or HTTP itself, only the local directory it's handed.
export async function runGateJob(job: GateJobSpec, limits: RunnerLimits, checkoutDir: string): Promise<ExecutionResult> {
  const name = containerNameFor(job.id);

  try {
    await execFileAsync("docker", buildCreateArgs(job, limits));
  } catch (err) {
    const { exitCode, message } = execErrorInfo(err);
    return { status: "failed", exitCode, logs: message };
  }

  try {
    await execFileAsync("docker", ["cp", `${checkoutDir}/.`, `${name}:${WORKDIR}`]);
  } catch (err) {
    await removeContainer(name);
    const { message } = execErrorInfo(err);
    return { status: "error", exitCode: null, logs: `docker cp failed: ${message}` };
  }

  return new Promise((resolve) => {
    const child = spawn("docker", ["start", "-a", name], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      void killContainer(name);
    }, job.timeoutMs);

    const append = (chunk: Buffer) => {
      if (output.length < LOG_BYTE_LIMIT) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: "error", exitCode: null, logs: `${output}\n${err.message}`.slice(0, LOG_BYTE_LIMIT) });
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const logs = output.slice(0, LOG_BYTE_LIMIT);
      if (timedOut) {
        resolve({ status: "timed_out", exitCode: null, logs });
        return;
      }
      resolve({ status: exitCode === 0 ? "succeeded" : "failed", exitCode, logs });
    });
  });
}
