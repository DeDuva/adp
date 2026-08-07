/**
 * Shared gate for the live-network tier, which needs egress to the public
 * OSV.dev API.
 *
 * `src/core/dependency-admission.ts` is a client for two third-party APIs, so
 * a slice of its coverage is deliberately unmocked — real OSV.dev, real npm
 * registry, real packages (see the "live network" describe blocks). That is
 * the right call: mocks cannot tell you the upstream response shape still
 * matches. But it makes those suites fail on any machine whose egress does not
 * include api.osv.dev — an offline laptop, a locked-down build agent, or an
 * agent sandbox whose proxy answers 403 to CONNECT for un-allowlisted hosts.
 * Failing there reports a *network policy* as a bug in dependency admission.
 *
 * This is the same problem `require-db.ts` solves for Postgres, and it gets the
 * same answer, with one difference. A database is either configured or not, so
 * that gate can read an env var; egress is not declared anywhere, so this one
 * probes for it once and caches the verdict.
 *
 *   reachable                       -> the live tier runs (unchanged behavior)
 *   unreachable                     -> the live tier skips, with a loud banner
 *   unreachable + ADP_REQUIRE_NETWORK=1 -> hard failure at import time
 *
 * CI sets `ADP_REQUIRE_NETWORK=1` (.github/workflows/ci.yml) for exactly the
 * reason `ADP_REQUIRE_DB=1` is set beside it: a context that intends full
 * coverage must not be able to go quietly green on a partial run.
 */

const TRUTHY = new Set(["1", "true", "yes", "on"]);

const requireNetwork = TRUTHY.has((process.env.ADP_REQUIRE_NETWORK ?? "").trim().toLowerCase());

/** The one host the live tier cannot substitute for. */
export const LIVE_NETWORK_PROBE_URL = "https://api.osv.dev/v1/query";

/**
 * Probe with the same request the live tests make, rather than a HEAD or a
 * DNS lookup: an egress proxy can resolve and connect while still refusing the
 * method, and a gateway can answer the root path while 403-ing the API.
 */
async function probe(): Promise<string | null> {
  try {
    const res = await fetch(LIVE_NETWORK_PROBE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package: { name: "is-odd", ecosystem: "npm" }, version: "3.0.1" }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const unreachable = await probe();

if (unreachable && requireNetwork) {
  throw new Error(
    `ADP_REQUIRE_NETWORK is set, but ${LIVE_NETWORK_PROBE_URL} is unreachable ` +
      `(${unreachable}) — the live-network tier cannot run and would otherwise ` +
      "be silently skipped.\n" +
      "Allow egress to api.osv.dev and registry.npmjs.org, or unset " +
      "ADP_REQUIRE_NETWORK to allow the live tier to skip.",
  );
}

if (unreachable) {
  console.warn(
    `\n[live-network tier SKIPPED] ${LIVE_NETWORK_PROBE_URL} is unreachable (${unreachable}).\n` +
      "  The unmocked OSV.dev/npm-registry coverage did not run. This is a green\n" +
      "  run with less coverage than a full one — set ADP_REQUIRE_NETWORK=1 to\n" +
      "  make it a hard failure instead.\n",
  );
}

/** Pass to `describe.skipIf()`. Always false when the probe succeeded. */
export const skipWithoutNetwork = unreachable !== null;
