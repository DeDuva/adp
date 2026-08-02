#!/usr/bin/env node
// The reference scanner-as-gate adapter (docs/pragmatic_mvp.md M2 — "Wiz
// Code (wizcli) is the reference adapter"). Consumes a SARIF file wizcli
// already produced, rather than invoking `wizcli scan` itself: the exact
// scan subcommand/policy flags vary by Wiz plan and version, and this repo
// has no Wiz license to verify them against a live account, so hardcoding
// them here would be a guess dressed up as fact. What's stable and
// documented is the output flag —
//   wizcli scan dir <path> --types <IaC type> --policies <policy> \
//     --sarif-output-file wiz-results.sarif
// (Wiz's own docs, e.g. Harness's Wiz IaC-scan integration page) — so run
// that yourself first, then point this adapter at the result.
//
// Usage:
//   node adapters/wizcli/run.mjs --sarif wiz-results.sarif \
//     --repo <owner>/<repo> --sha <sha> \
//     [--server <url>] [--token <token>] [--gate-name wizcli] [--fail-level warning]
//
// --fail-level (default "warning", one of error/warning/note/none): the
// minimum SARIF severity that fails the gate. Defaults conservatively —
// see adapters/lib/sarif.mjs's comment on why "error only" would silently
// pass real findings from at least one real scanner.
import { readFile } from "node:fs/promises";
import { parseFlags, splitRepo } from "../lib/args.mjs";
import { parseSarif } from "../lib/sarif.mjs";
import { reportGate } from "../lib/report.mjs";
import { resolveShaOrHead } from "../lib/resolve-sha.mjs";

export async function main(argv, env = process.env) {
  const flags = parseFlags(argv);
  if (!flags.sarif || !flags.repo) {
    throw new Error(
      "usage: adapters/wizcli/run.mjs --sarif <path> --repo <owner>/<repo> [--sha <sha>] [--server <url>] [--token <token>] [--gate-name wizcli]",
    );
  }
  const { owner, repo } = splitRepo(flags.repo);
  const serverUrl = flags.server ?? env.ADP_SERVER_URL;
  const token = flags.token ?? env.ADP_TOKEN;
  if (!serverUrl || !token) {
    throw new Error("server URL and token required: --server/--token or ADP_SERVER_URL/ADP_TOKEN");
  }

  const sarifText = await readFile(flags.sarif, "utf8");
  const { status, summary } = parseSarif(sarifText, { failLevel: flags["fail-level"] });
  const sha = await resolveShaOrHead(flags.sha);

  const result = await reportGate({
    serverUrl,
    token,
    owner,
    repo,
    sha,
    name: flags["gate-name"] ?? "wizcli",
    status,
    summary,
  });
  console.log(`wizcli gate reported: ${status} — ${summary}`);
  return result;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`wizcli adapter: ${err.message}`);
    process.exitCode = 1;
  });
}
