#!/usr/bin/env node
// CLI wrapper for arm 1. The measurement itself is bench/lib/merge-contention.mjs,
// which the server's e2e suite also drives — one implementation, so the number
// CI enforces and the number published here come from the same code.
//
//   ADP_SERVER_URL=... ADP_TOKEN=... node arms/merge-contention.mjs \
//     --owner acme --repo widget --writers 16 [--out ../runs/<name>.json]

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMergeContention } from "../lib/merge-contention.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.ADP_SERVER_URL;
  const token = process.env.ADP_TOKEN;

  if (!baseUrl || !token || !args.owner || !args.repo) {
    console.error(
      "Usage: ADP_SERVER_URL=... ADP_TOKEN=... node arms/merge-contention.mjs --owner <owner> --repo <repo> [--writers N] [--base main] [--out FILE]",
    );
    process.exit(2);
  }

  const writers = Number(args.writers ?? 8);
  const result = await runMergeContention({
    baseUrl,
    token,
    owner: args.owner,
    repo: args.repo,
    writers,
    baseRef: args.base ?? "main",
  });

  // The reproducibility contract (bench/README.md): a run record carries enough
  // context to re-derive and re-run it. A number without its environment is not
  // evidence, it is an anecdote.
  const record = {
    recordedAt: new Date().toISOString(),
    arm: "merge-contention",
    deterministic: true,
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      serverUrl: baseUrl,
      serverCommit: process.env.ADP_SERVER_COMMIT ?? null,
    },
    result,
  };

  const output = JSON.stringify(record, null, 2);
  if (args.out) {
    const target = path.resolve(String(args.out));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${output}\n`);
    console.error(`wrote ${path.relative(path.dirname(fileURLToPath(import.meta.url)), target)}`);
  }
  console.log(output);

  // A run where writers failed for reasons other than contention is not a
  // result, it is a broken run — exit nonzero rather than publishing it.
  if (result.failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
