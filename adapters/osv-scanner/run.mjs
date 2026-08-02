#!/usr/bin/env node
// The second scanner-as-gate adapter (docs/pragmatic_mvp.md M2 — "one open
// engine (e.g. osv-scanner) as the second implementation proving the
// adapter interface"). Deliberately reads osv-scanner's own native JSON
// (not its SARIF output, which wizcli's adapter already exercises) — the
// point of a second adapter is proving the gate-report contract
// generalizes beyond one shared format. Produce the input with:
//   osv-scanner scan -L <lockfile> --format json > osv-results.json
// (https://google.github.io/osv-scanner/output/).
//
// Usage:
//   node adapters/osv-scanner/run.mjs --json osv-results.json \
//     --repo <owner>/<repo> --sha <sha> \
//     [--server <url>] [--token <token>] [--gate-name osv-scanner]
import { readFile } from "node:fs/promises";
import { parseFlags, splitRepo } from "../lib/args.mjs";
import { parseOsvJson } from "../lib/osv-json.mjs";
import { reportGate } from "../lib/report.mjs";
import { resolveShaOrHead } from "../lib/resolve-sha.mjs";

export async function main(argv, env = process.env) {
  const flags = parseFlags(argv);
  if (!flags.json || !flags.repo) {
    throw new Error(
      "usage: adapters/osv-scanner/run.mjs --json <path> --repo <owner>/<repo> [--sha <sha>] [--server <url>] [--token <token>] [--gate-name osv-scanner]",
    );
  }
  const { owner, repo } = splitRepo(flags.repo);
  const serverUrl = flags.server ?? env.ADP_SERVER_URL;
  const token = flags.token ?? env.ADP_TOKEN;
  if (!serverUrl || !token) {
    throw new Error("server URL and token required: --server/--token or ADP_SERVER_URL/ADP_TOKEN");
  }

  const jsonText = await readFile(flags.json, "utf8");
  const { status, summary } = parseOsvJson(jsonText);
  const sha = await resolveShaOrHead(flags.sha);

  const result = await reportGate({
    serverUrl,
    token,
    owner,
    repo,
    sha,
    name: flags["gate-name"] ?? "osv-scanner",
    status,
    summary,
  });
  console.log(`osv-scanner gate reported: ${status} — ${summary}`);
  return result;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`osv-scanner adapter: ${err.message}`);
    process.exitCode = 1;
  });
}
