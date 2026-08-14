import { rm } from "node:fs/promises";
import { loadConfig, imageAllowed, type Config } from "./config.js";
import { GateJobClient } from "./client.js";
import { runGateJob } from "./docker.js";
import { materializeCheckout } from "./checkout.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One claim -> checkout -> run -> complete cycle. Returns whether a job was
// claimed, so the caller can poll again immediately rather than waiting out
// the interval while work is queued.
//
// `run` defaults to the real Docker executor but is injectable so this
// function's own wiring (does a claimed job's checkout land, does it run
// with the right image/command/limits, does the result get reported back
// under the same job id) is unit-testable without needing a real Docker
// daemon in every environment that runs `npm test` here — docker.test.ts is
// what proves the executor itself against the real thing.
export async function pollOnce(client: GateJobClient, config: Config, run: typeof runGateJob = runGateJob): Promise<boolean> {
  const job = await client.claim(config.RUNNER_ID);
  if (!job) return false;

  // #100: the image is repo-controlled (any pushed adp.yaml names one), so
  // the host operator's allowlist gets the last word — checked before the
  // checkout is even fetched, and reported as a terminal `error` rather
  // than left to the reaper: the job can never succeed on this host, and a
  // requeue loop against the same allowlist would grind the retry cap for
  // nothing.
  if (!imageAllowed(job.image, config.RUNNER_IMAGE_ALLOWLIST)) {
    await client.complete(job.id, {
      status: "error",
      exitCode: null,
      logs: `image '${job.image}' is not permitted by this runner's RUNNER_IMAGE_ALLOWLIST`,
    });
    return true;
  }

  const tar = await client.checkout(job.id);
  const checkoutDir = await materializeCheckout(tar);
  try {
    const result = await run(
      { id: job.id, image: job.image, command: job.command, timeoutMs: job.timeout_ms },
      { memory: config.RUNNER_MEMORY, cpus: config.RUNNER_CPUS, pidsLimit: config.RUNNER_PIDS_LIMIT },
      checkoutDir,
    );
    await client.complete(job.id, result);
  } finally {
    await rm(checkoutDir, { recursive: true, force: true });
  }
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
