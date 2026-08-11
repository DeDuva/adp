import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Same ceiling http-rest/gate-jobs.ts's CompleteBody enforces on the server
// side — truncated here too, so a runaway container's output gets reported
// as a useful (truncated) tail instead of the completion call itself being
// rejected with a 422 over an oversized body.
const LOG_BYTE_LIMIT = 1_000_000;

export interface GateJobSpec {
  id: string;
  image: string;
  command: string;
  timeoutMs: number;
}

export interface RunnerLimits {
  memory: string;
  cpus: string;
}

export interface ExecutionResult {
  status: "succeeded" | "failed" | "timed_out" | "error";
  exitCode: number | null;
  logs: string;
}

function containerNameFor(jobId: string): string {
  return `adp-gate-${jobId}`;
}

// The isolation bar this executor exists to enforce (pragmatic_mvp.md
// §4.5/§4.7): network-deny by default, no host mounts, no ambient secrets,
// CPU/memory caps. Each of those is an *absence* from this argument list —
// there is no `-v` anywhere (no host mounts), no `-e`/`--env-file` (no
// ambient secrets; `docker run` never forwards the host's own environment
// into a container unless told to). Per-job network allowlisting from
// `adp.yaml` is not built yet — that parsing is M4-9c's job, and this
// executor is deliberately adp.yaml-agnostic: it only ever sees the
// image/command a gate_jobs row already carries.
export function buildDockerArgs(job: GateJobSpec, limits: RunnerLimits): string[] {
  return [
    "run",
    "--rm",
    "--name",
    containerNameFor(job.id),
    "--network",
    "none",
    "--memory",
    limits.memory,
    "--cpus",
    limits.cpus,
    job.image,
    "sh",
    "-c",
    job.command,
  ];
}

// Killing the spawned `docker run` client process is not enough on its own —
// the container it started keeps running detached from that client — so a
// timeout has to reach the daemon directly by the name we gave it.
async function killContainer(name: string): Promise<void> {
  try {
    await execFileAsync("docker", ["kill", name]);
  } catch {
    // Lost the race: the container had already exited on its own between the
    // timeout firing and this running. Not an error.
  }
}

// The wall-clock half of the isolation bar. `docker run` blocks in the
// foreground for the container's lifetime and exits with its exit code, so a
// plain child-process timeout would just abandon our own wait — the container
// keeps running unsupervised. `docker kill` by name is what actually stops it.
export function runGateJob(job: GateJobSpec, limits: RunnerLimits): Promise<ExecutionResult> {
  const args = buildDockerArgs(job, limits);
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      void killContainer(containerNameFor(job.id));
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
