#!/usr/bin/env node
import { login } from "./commands/login.js";
import { repoMirror } from "./commands/repo-mirror.js";
import { gateReport } from "./commands/gate-report.js";
import { prList } from "./commands/pr-list.js";
import { prMerge } from "./commands/pr-merge.js";
import { connect, disconnect } from "./commands/connect.js";
import { ApiError } from "./api.js";

const USAGE = `adp — a CLI for ADP servers

Usage:
  adp login --server <url> --token <token>
  adp repo mirror <owner>/<repo> --remote-url <url> --secret <secret> --credential <credential> [--direction outbound|inbound|both]
  adp gate report --repo <owner>/<repo> --sha <sha> --name <name> --status <success|failure|pending> [--summary <text>]
  adp pr list --repo <owner>/<repo>
  adp pr merge --repo <owner>/<repo> --number <n> [--method merge|squash|rebase]
  adp connect <claude-code|codex|gemini-cli> [--repo <owner>/<repo>] [--model <name>]
  adp disconnect <claude-code|codex|gemini-cli>
`;

// First CLI in this repo — thin REST wrapper reusing the same bearer-token
// auth every other client (gh, the MCP server) already uses against
// server/src/http-rest/*. No subcommand framework: seven commands, two
// levels deep at most, doesn't earn one (cli/src/args.ts's comment applies
// here too).
//
// `connect` is the one that is not a REST wrapper (#154). It writes files, and
// then proves they work — see commands/connect.ts.
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
