/**
 * Shared gate for the end-to-end tier, which needs a real Postgres.
 *
 * The original behavior — `describe.skipIf(!process.env.DATABASE_URL)` in each
 * e2e file — exists for a good reason: `npm test` should stay usable on a
 * machine with no database. The problem is that it makes a *pass* and a *skip*
 * indistinguishable at the exit code, so a run with the entire e2e tier
 * disabled reports green. That is the "partial run" failure mode
 * (docs/test-environment-automation.md, finding 1).
 *
 * So the skip stays the default, and any context that *intends* full coverage
 * declares it by setting `ADP_REQUIRE_DB=1` — CI, and the local dev scripts.
 * With it set, a missing DATABASE_URL throws here at import time, which vitest
 * reports as a collection failure for every suite that imports this module.
 * Loud, and impossible to mistake for a pass.
 */

const TRUTHY = new Set(["1", "true", "yes", "on"]);

const requireDb = TRUTHY.has((process.env.ADP_REQUIRE_DB ?? "").trim().toLowerCase());
const databaseUrl = process.env.DATABASE_URL?.trim();

if (requireDb && !databaseUrl) {
  throw new Error(
    "ADP_REQUIRE_DB is set, but DATABASE_URL is empty — the end-to-end tier " +
      "cannot run and would otherwise be silently skipped.\n" +
      "Start a Postgres and export a DSN, e.g.:\n" +
      "  export DATABASE_URL=postgres://adp:adp@localhost:5432/adp\n" +
      "Or unset ADP_REQUIRE_DB to allow the e2e tier to skip.",
  );
}

/** Pass to `describe.skipIf()`. Always false when ADP_REQUIRE_DB is set. */
export const skipWithoutDb = !databaseUrl;
