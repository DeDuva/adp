import { loadConfig, type Config } from "./config.js";
import { GateJobClient } from "./client.js";
import { runGateJob } from "./docker.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One claim -> run -> complete cycle. Returns whether a job was claimed, so
// the caller can poll again immediately rather than waiting out the interval
// while work is queued.
//
// `run` defaults to the real Docker executor but is injectable so this
// function's own wiring (does a claimed job get run with the right
// image/command/limits, does the result get reported back under the same
// job id) is unit-testable without needing a real Docker daemon in every
// environment that runs `npm test` here — docker.test.ts is what proves the
// executor itself against the real thing.
export async function pollOnce(client: GateJobClient, config: Config, run: typeof runGateJob = runGateJob): Promise<boolean> {
  const job = await client.claim(config.RUNNER_ID);
  if (!job) return false;

  const result = await run(
    { id: job.id, image: job.image, command: job.command, timeoutMs: job.timeout_ms },
    { memory: config.RUNNER_MEMORY, cpus: config.RUNNER_CPUS },
  );
  await client.complete(job.id, result);
  return true;
}

async function main() {
  const config = loadConfig();
  const client = new GateJobClient(config.ADP_SERVER_URL, config.ADP_RUNNER_TOKEN);

  console.log(`adp-runner ${config.RUNNER_ID} polling ${config.ADP_SERVER_URL}`);

  for (;;) {
    let claimed = false;
    try {
      claimed = await pollOnce(client, config);
    } catch (err) {
      console.error("poll cycle failed:", err instanceof Error ? err.message : err);
    }
    if (!claimed) await sleep(config.POLL_INTERVAL_MS);
  }
}

// Only run the loop when invoked directly (`node dist/main.js`), not when
// imported by tests — same guard style as reaching for a `--help`-only mode
// would need, just inverted: import-for-testing is the common case here.
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((err) => {
    console.error("adp-runner exited:", err);
    process.exit(1);
  });
}
