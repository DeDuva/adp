import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "../src/db/client.js";

/**
 * Apply migrations exactly once, before any suite starts.
 *
 * Each e2e suite calls `migrate()` in its own `beforeAll`, and vitest runs
 * suites in parallel — so against an *empty* database eight migrators race to
 * create the same tables, and some lose. It never showed up before because the
 * two environments that ran the e2e tier both had migrations already applied by
 * the time the suites started: CI runs `npm run migrate` as a separate step,
 * and a developer's long-lived local Postgres was migrated days ago.
 *
 * A per-run ephemeral database (scripts/dev/up.sh) removes both accidents and
 * the race becomes reproducible — which is the point of testing on a genuinely
 * fresh machine. Running migrations here makes every suite's own `migrate()`
 * call a no-op journal read, which is concurrency-safe, and drops the
 * dependency on someone remembering to migrate first.
 */
export async function setup() {
  const databaseUrl = process.env.DATABASE_URL;
  // No database configured means the e2e tier is skipping anyway
  // (test/require-db.ts owns whether that is allowed).
  if (!databaseUrl) return;

  const { db, pool } = createDb(databaseUrl);
  try {
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  } finally {
    await pool.end();
  }
}
