import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client.js";
import { loadConfig } from "../config.js";

// Migrations run behind a Postgres advisory lock so concurrent boots don't race.
const ADVISORY_LOCK_KEY = 727_001;

async function main() {
  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL);

  await pool.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
  try {
    await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
    console.log("Migrations applied.");
  } finally {
    await pool.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
