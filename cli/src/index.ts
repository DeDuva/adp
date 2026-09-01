#!/usr/bin/env node
import { login } from "./commands/login.js";
import { repoMirror } from "./commands/repo-mirror.js";
import { gateReport } from "./commands/gate-report.js";
import { prList } from "./commands/pr-list.js";
import { prMerge } from "./commands/pr-merge.js";
import { connect, disconnect } from "./commands/connect.js";
import { prReview } from "./commands/pr-review.js";
import { watch } from "./commands/watch.js";
import { undo } from "./commands/undo.js";
import { bakeoff, bakeoffResults } from "./commands/bakeoff.js";
import { runnerUp } from "./commands/runner.js";
import { ApiError } from "./api.js";

const USAGE = `adp — a CLI for ADP servers

Usage:
  adp login --server <url> --token <token>
  adp repo mirror <owner>/<repo> --remote-url <url> --secret <secret> --credential <credential> [--direction outbound|inbound|both]
  adp gate report --repo <owner>/<repo> --sha <sha> --name <name> --status <success|failure|pending> [--summary <text>]
  adp pr list --repo <owner>/<repo>
  adp pr merge --repo <owner>/<repo> --number <n> [--method merge|squash|rebase]
  adp pr review --repo <owner>/<repo> --number <n> --state <approved|changes_requested|commented> [--body <text>]
  adp watch --repo <owner>/<repo> [--pr <n>] [--interval <seconds>] [--once]
  adp undo <sha> --repo <owner>/<repo>
  adp bakeoff --repo <owner>/<repo> --intent <uuid|#issue> --harness <a,b,c> [--orchestrator <name>]
  adp bakeoff results --repo <owner>/<repo> --intent <uuid|#issue>
  adp runner up --here [--server <url>] [--token <token>]
  adp connect <claude-code|codex|gemini-cli> [--repo <owner>/<repo>] [--model <name>]
  adp disconnect <claude-code|codex|gemini-cli>
`;

// Thin REST wrappers reusing the same bearer-token auth every other client (gh,
// the MCP server) already uses against server/src/http-rest/*, plus the three
// that are not: `connect` writes files and then proves they work (#154),
// `runner up` starts another process, and `bakeoff` drives four calls to open
// what a comparison needs.
//
// Still no subcommand framework. #153 argues these are "a different shape of
// program" and will want one; what is here is thirteen commands two levels deep
// with a flag parser in twenty lines, and a framework bought now would be bought
// before the shape it is meant to fit exists. cli/src/args.ts's comment applies.
export async function run(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  try {
    switch (cmd) {
      case "login":
        await login(rest);
        return 0;
      case "connect":
        await connect(rest);
        return 0;
      case "disconnect":
        await disconnect(rest);
        return 0;
      // #155: the four verbs the native plane's most distinctive capabilities
      // had no command for, so the documented way to reach them was `curl`.
      case "watch":
        await watch(rest);
        return 0;
      case "undo":
        await undo(rest);
        return 0;
      case "bakeoff": {
        if (rest[0] === "results") {
          await bakeoffResults(rest.slice(1));
          return 0;
        }
        await bakeoff(rest);
        return 0;
      }
      case "runner": {
        const [sub, ...args] = rest;
        if (sub === "up") {
          await runnerUp(args);
          return 0;
        }
        break;
      }
      case "repo": {
        const [sub, ...args] = rest;
        if (sub === "mirror") {
          await repoMirror(args);
          return 0;
        }
        break;
      }
      case "gate": {
        const [sub, ...args] = rest;
        if (sub === "report") {
          await gateReport(args);
          return 0;
        }
        break;
      }
      case "pr": {
        const [sub, ...args] = rest;
        if (sub === "list") {
          await prList(args);
          return 0;
        }
        if (sub === "merge") {
          await prMerge(args);
          return 0;
        }
        if (sub === "review") {
          await prReview(args);
          return 0;
        }
        break;
      }
    }
  } catch (err) {
    const status = err instanceof ApiError ? ` (HTTP ${err.status})` : "";
    console.error(`adp: ${err instanceof Error ? err.message : String(err)}${status}`);
    return 1;
  }

  console.log(USAGE);
  return cmd ? 1 : 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
