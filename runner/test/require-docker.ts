import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Shared gate for the tier that runs real containers, mirroring
 * server/test/require-db.ts's shape for Postgres and require-network.ts's
 * for live egress — same problem, same answer: a mocked `docker run` cannot
 * tell you the isolation flags this package's entire job is enforcing
 * (network-deny, no host mounts) actually take effect against the real
 * daemon, so a slice of coverage here is deliberately real Docker, not a
 * fake child process.
 *
 *   docker reachable                       -> the real-container tier runs
 *   docker unreachable                     -> it skips, with a loud banner
 *   unreachable + ADP_REQUIRE_DOCKER=1     -> hard failure at import time
 *
 * CI sets ADP_REQUIRE_DOCKER=1 for the same reason ADP_REQUIRE_DB=1 is set
 * beside it in server/: a context that intends full coverage must not be
 * able to go quietly green on a partial run.
 */

const TRUTHY = new Set(["1", "true", "yes", "on"]);

const requireDocker = TRUTHY.has((process.env.ADP_REQUIRE_DOCKER ?? "").trim().toLowerCase());

async function probe(): Promise<string | null> {
  try {
    await execFileAsync("docker", ["info"]);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const unreachable = await probe();

if (unreachable && requireDocker) {
  throw new Error(
    "ADP_REQUIRE_DOCKER is set, but the Docker daemon is unreachable " +
      `(${unreachable}) — the real-container tier cannot run and would otherwise ` +
      "be silently skipped.\n" +
      "Start Docker, or unset ADP_REQUIRE_DOCKER to allow this tier to skip.",
  );
}

if (unreachable) {
  console.warn(
    `\n[real-container tier SKIPPED] Docker is unreachable (${unreachable}).\n` +
      "  The real docker-run isolation coverage did not run. This is a green\n" +
      "  run with less coverage than a full one — set ADP_REQUIRE_DOCKER=1 to\n" +
      "  make it a hard failure instead.\n",
  );
}

/** Pass to `describe.skipIf()`. Always false when the probe succeeded. */
export const skipWithoutDocker = unreachable !== null;
