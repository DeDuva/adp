#!/usr/bin/env node
import { login } from "./commands/login.js";
import { init } from "./commands/init.js";
import { repoMirror } from "./commands/repo-mirror.js";
import { gateReport } from "./commands/gate-report.js";
import { prList } from "./commands/pr-list.js";
import { prMerge } from "./commands/pr-merge.js";
import { prReview } from "./commands/pr-review.js";
import { connect, disconnect } from "./commands/connect.js";
import { watch } from "./commands/watch.js";
import { undo } from "./commands/undo.js";
import { bakeoff, bakeoffResults } from "./commands/bakeoff.js";
import { reimplement } from "./commands/reimplement.js";
import { runnerUp } from "./commands/runner.js";
import { ApiError } from "./api.js";

export interface Command {
  /** The words that select it, in order: `["pr", "merge"]`. */
  path: string[];
  /** The rest of the usage line, after the words above. */
  args: string;
  /** One line, present tense, describing what it does rather than what it wraps. */
  summary: string;
  run(argv: string[]): Promise<void>;
}

// #153 argues that `init`, `connect`, `watch`, `bakeoff`, `undo` and `runner`
// are "a different shape of program" from five thin REST wrappers, and that
// this is where the CLI earns a subcommand framework.
//
// This is the half of that which is actually earned. The failure a framework
// would prevent here is not parsing — the flag parser is twenty lines and has
// never been the problem — it is **drift between the dispatcher and the usage
// text**, which were two hand-maintained lists of the same thing. So there is
// one list: dispatch reads it, `--help` renders it, and a test asserts every
// entry is reachable. A dependency would have bought the same property along
// with an opinion about everything else.
export const COMMANDS: Command[] = [
  { path: ["init"], args: "[--repo <owner>/<repo>] [--mirror <url>] [--no-mirror] [--credential <token>]",
    summary: "attach ADP to this repository — org, repo, mirror, adp.yaml", run: init },
  { path: ["login"], args: "--server <url> --token <token>",
    summary: "store the server and token this CLI uses", run: login },
  { path: ["watch"], args: "--repo <owner>/<repo> [--pr <n>] [--interval <seconds>] [--once]",
    summary: "the proposal, its gates, its runs, and whether it would land", run: watch },
  { path: ["undo"], args: "<sha> --repo <owner>/<repo>",
    summary: "undo the merge that produced a commit, by rollback or by revert", run: undo },
  { path: ["bakeoff"], args: "--repo <owner>/<repo> --intent <uuid|#issue> --harness <a,b,c> [--orchestrator <name>]",
    summary: "one intent, one run per harness, one comparison", run: bakeoff },
  { path: ["bakeoff", "results"], args: "--repo <owner>/<repo> --intent <uuid|#issue>",
    summary: "the comparison for an intent that already has runs", run: bakeoffResults },
  { path: ["reimplement"], args: "<sha> [--harness <name>] [--model <name>] [--compare] [--repo <owner>/<repo>]",
    summary: "do a landed change again, with a second run related to the first, and show the difference",
    run: reimplement },
  { path: ["runner", "up"], args: "--here [--server <url>] [--token <token>]",
    summary: "start a gate runner, or refuse and say why not here", run: runnerUp },
  { path: ["gate", "report"], args: "--repo <owner>/<repo> --sha <sha> --name <name> --status <success|failure|pending> [--summary <text>]",
    summary: "attest a gate result against a commit", run: gateReport },
  { path: ["pr", "list"], args: "--repo <owner>/<repo>", summary: "list proposals", run: prList },
  { path: ["pr", "merge"], args: "--repo <owner>/<repo> --number <n> [--method merge|squash|rebase]",
    summary: "land a proposal, or read the refusal", run: prMerge },
  { path: ["pr", "review"], args: "--repo <owner>/<repo> --number <n> --state <approved|changes_requested|commented> [--body <text>]",
    summary: "record a typed review", run: prReview },
  { path: ["repo", "mirror"], args: "<owner>/<repo> --remote-url <url> --secret <secret> --credential <credential> [--direction outbound|inbound|both]",
    summary: "configure mirror mode by hand — `adp init` does this for you", run: repoMirror },
  { path: ["connect"], args: "<claude-code|codex|gemini-cli> [--repo <owner>/<repo>] [--model <name>]",
    summary: "write a harness's own configuration, then prove it works", run: connect },
  { path: ["disconnect"], args: "<harness>", summary: "undo exactly what connect wrote", run: disconnect },
];

export function usage(): string {
  const lines = ["adp — a CLI for ADP servers", "", "Usage:"];
  const width = Math.max(...COMMANDS.map((c) => c.path.join(" ").length));
  for (const command of COMMANDS) {
    lines.push(`  adp ${command.path.join(" ")} ${command.args}`);
    lines.push(`  ${" ".repeat(width + 4)}${command.summary}`);
  }
  return lines.join("\n") + "\n";
}

// Longest path first, so `bakeoff results` is matched before `bakeoff` and
// `runner up` before a bare `runner` that does not exist.
export function match(argv: string[]): { command: Command; rest: string[] } | null {
  for (const command of [...COMMANDS].sort((a, b) => b.path.length - a.path.length)) {
    if (command.path.every((word, i) => argv[i] === word)) {
      return { command, rest: argv.slice(command.path.length) };
    }
  }
  return null;
}

export async function run(argv: string[]): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    console.log(usage());
    return 0;
  }

  const matched = match(argv);
  if (!matched) {
    console.log(usage());
    return argv.length > 0 ? 1 : 0;
  }

  try {
    await matched.command.run(matched.rest);
    return 0;
  } catch (err) {
    const status = err instanceof ApiError ? ` (HTTP ${err.status})` : "";
    console.error(`adp: ${err instanceof Error ? err.message : String(err)}${status}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
