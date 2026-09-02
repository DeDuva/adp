import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

// Running the harnesses, rather than printing what to run.
//
// `adp bakeoff` created the candidate set and the labelled runs and then
// **explicitly did not launch the agents**: it printed one `adp-recorder wrap …`
// line per harness and left the developer to wire each one in. That is a
// defensible boundary for a substrate and the wrong one for a product — the
// comparison a bake-off exists to produce is exactly what nobody will assemble
// by hand N times, so the feature was used least where it is worth most.
//
// **Opt-in, and the flag is the acknowledgement.** `adp init` settled the same
// question for the gate runner: a process that mounts the Docker socket does not
// start without being told this is the right host, and `--runner` is how one
// command still does it. Launching a harness is a smaller grant than that and it
// is still a grant — it spends money, it edits files, and it does both without
// asking again. So `--launch` is required, and the cost is shown before the run
// rather than after.

/** What one arm of a launch is: a run, a harness, and the tree it works in. */
export interface Arm {
  harness: string;
  runId: string;
  /** The label the comparison will show this arm under. */
  label: string;
}

export interface LaunchSpec {
  arm: Arm;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface LaunchResult {
  arm: Arm;
  status: "finished" | "failed" | "unavailable";
  code: number | null;
  reason?: string;
}

/**
 * How to run each harness non-interactively, emitting the stream its reader
 * expects.
 *
 * One place, because it is the only thing in the CLI that has to know a
 * harness's command line — and the readers already hold the other half of that
 * knowledge in `recorder/src/readers/`. A harness this does not know is not an
 * error: it degrades to the printed instructions, which is the path that
 * existed before and has to keep existing.
 */
export function harnessCommand(harness: string, prompt: string): { command: string; args: string[] } | null {
  switch (harness) {
    case "claude-code":
      return { command: "claude", args: ["-p", prompt, "--output-format", "stream-json", "--verbose"] };
    case "codex":
      return { command: "codex", args: ["exec", "--json", prompt] };
    case "gemini-cli":
      return { command: "gemini", args: ["--output-format", "json", "-p", prompt] };
    default:
      return null;
  }
}

/** Whether the harness's binary is on this machine's PATH. */
export function harnessAvailable(command: string): boolean {
  try {
    execFileSync("command", ["-v", command], { stdio: "ignore", shell: "/bin/sh" });
    return true;
  } catch {
    return false;
  }
}

/**
 * A git worktree per arm, at the base the comparison is against.
 *
 * **N agents cannot share one checkout.** They edit the same files at the same
 * time, and the comparison that results is of two agents fighting rather than of
 * two agents working — which would be a worse answer than no answer, because it
 * would look like a real one. A worktree is the same answer this repository uses
 * for its own concurrent work, for the same reason.
 *
 * Returns null when the directory already exists, so a re-run reuses a tree
 * rather than failing or silently working somewhere else.
 */
export function armWorktree(root: string, dir: string, branch: string, base: string): string {
  const target = path.join(root, dir);
  if (existsSync(target)) return target;
  mkdirSync(path.dirname(target), { recursive: true });
  execFileSync("git", ["worktree", "add", "-B", branch, target, base], { cwd: root, stdio: "ignore" });
  return target;
}

export interface RunArmsOptions {
  /** How many harnesses may run at once. */
  concurrency?: number;
  /** Injected in tests, so the composition is assertable without spawning agents. */
  spawnImpl?: typeof spawn;
  onStart?: (spec: LaunchSpec) => void;
  onFinish?: (result: LaunchResult) => void;
}

/**
 * Run the arms, bounded, and return when there is something to compare.
 *
 * Bounded because the failure of an unbounded fan-out is not slowness: it is N
 * agents against one machine's rate limits, all of them degrading, and a
 * comparison of how each harness behaves under contention rather than of how it
 * does the work. Two at a time by default, which is the number that keeps a
 * two-arm bake-off — the common case — genuinely parallel.
 *
 * An arm that cannot start is reported and does not stop the others. A bake-off
 * where one harness is not installed should still produce the comparison
 * between the ones that are.
 */
export async function runArms(specs: LaunchSpec[], options: RunArmsOptions = {}): Promise<LaunchResult[]> {
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const spawnImpl = options.spawnImpl ?? spawn;
  const results: LaunchResult[] = [];
  const queue = [...specs];

  const worker = async (): Promise<void> => {
    for (;;) {
      const spec = queue.shift();
      if (!spec) return;
      options.onStart?.(spec);
      const result = await new Promise<LaunchResult>((resolve) => {
        let child;
        try {
          child = spawnImpl(spec.command, spec.args, {
            cwd: spec.cwd,
            env: { ...process.env, ...spec.env },
            stdio: ["ignore", "inherit", "inherit"],
          });
        } catch (err) {
          resolve({
            arm: spec.arm,
            status: "unavailable",
            code: null,
            reason: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        child.on("error", (err: Error) =>
          resolve({ arm: spec.arm, status: "unavailable", code: null, reason: err.message }),
        );
        child.on("close", (code: number | null) =>
          resolve({ arm: spec.arm, status: code === 0 ? "finished" : "failed", code }),
        );
      });
      results.push(result);
      options.onFinish?.(result);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, specs.length) }, worker));
  return results;
}
