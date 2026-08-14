import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type Db } from "../db/client.js";
import { withTickLock, TICK_LOCKS } from "./tick-lock.js";
import { skipWithoutDb } from "../../test/require-db.js";

// #96 (audit §P1-6): the background writers used to run unconditionally per
// process — two replicas both swept, losers inflating the failure signal.
// These prove the advisory-lock guard both directions against real
// Postgres: a held lock means the tick does nothing and says so (null,
// which the caller must treat as "someone else has it", not as an error),
// and a released lock means the next tick runs normally.
describe.skipIf(skipWithoutDb)("withTickLock", () => {
  let db: Db;
  let pool: import("pg").Pool;

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("runs the work and returns its value when the lock is free", async () => {
    const result = await withTickLock(db, TICK_LOCKS.workspaceSweep, async () => "ran");
    expect(result).toBe("ran");
  });

  it("skips the work entirely — null, fn never called — while another connection holds the lock", async () => {
    const holder = await pool.connect();
    try {
      // A session-level advisory lock from the "other replica"; it shares
      // the lock ID space with the xact-level lock withTickLock takes.
      await holder.query("SELECT pg_advisory_lock($1)", [TICK_LOCKS.workspaceSweep]);

      let ran = false;
      const result = await withTickLock(db, TICK_LOCKS.workspaceSweep, async () => {
        ran = true;
        return "must-not-happen";
      });
      expect(result).toBeNull();
      expect(ran).toBe(false);

      // Distinct keys don't interfere: the reaper's tick is not blocked by
      // the sweeper's holder.
      const other = await withTickLock(db, TICK_LOCKS.gateJobReap, async () => "independent");
      expect(other).toBe("independent");
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [TICK_LOCKS.workspaceSweep]).catch(() => {});
      holder.release();
    }

    // Released: the very next tick proceeds — the lock is a turn-taking
    // mechanism, not a latch. This is also what makes a crashed holder
    // safe: its connection's death releases the lock implicitly.
    const after = await withTickLock(db, TICK_LOCKS.workspaceSweep, async () => "recovered");
    expect(after).toBe("recovered");
  });

  it("two genuinely concurrent ticks never both run the work", async () => {
    let running = 0;
    let maxConcurrent = 0;
    const work = async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((resolve) => setTimeout(resolve, 100));
      running--;
      return "ran";
    };

    const results = await Promise.all([
      withTickLock(db, TICK_LOCKS.workspaceSweep, work),
      withTickLock(db, TICK_LOCKS.workspaceSweep, work),
      withTickLock(db, TICK_LOCKS.workspaceSweep, work),
    ]);

    // try-lock semantics: losers skip rather than queue, so at most one runs
    // at a time — and at least one of the three must have won.
    expect(maxConcurrent).toBeLessThanOrEqual(1);
    expect(results.filter((r) => r === "ran").length).toBeGreaterThanOrEqual(1);
  });
});
