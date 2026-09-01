import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

// #96 (audit §P1-6): the background writers — the workspace sweeper and the
// gate-job reaper — used to run unconditionally per process. Two replicas
// both swept: the losers' git update-ref calls failed and counted as
// `failed` (inflating the one signal an operator watches), and every tick
// did redundant work. This is the missing mutual exclusion, and what makes
// running a second API replica safe at all.
//
// A transaction-scoped Postgres advisory lock, because the database is the
// one thing every replica already shares — no new coordination service, and
// a crashed holder releases implicitly when its connection dies.
// pg_try_advisory_XACT_lock on purpose: the lock lives exactly as long as
// the wrapping transaction, so there is no unlock bookkeeping to get wrong,
// and the inner work (which runs its own transactions on other pool
// connections) stays covered for the duration of the tick.
//
// Keys are arbitrary-but-stable bigints, namespaced under one prefix so a
// future lock can't collide by accident. Never reuse a value.
export const TICK_LOCKS = {
  workspaceSweep: 0x41445001,
  gateJobReap: 0x41445002,
  storageMeter: 0x41445003,
  // #161: the trajectory retention sweep.
  trajectoryRetention: 0x41445004,
} as const;

// Runs `fn` while holding the advisory lock, or — when another instance
// holds it — returns null WITHOUT running: this tick's work is exactly what
// the holder is already doing, and skipping is the point, not a failure.
export async function withTickLock<T>(db: Db, key: number, fn: () => Promise<T>): Promise<T | null> {
  return await db.transaction(async (tx) => {
    const result = await tx.execute(sql`select pg_try_advisory_xact_lock(${key}) as locked`);
    const locked = (result.rows[0] as { locked?: boolean } | undefined)?.locked === true;
    if (!locked) return null;
    return await fn();
  });
}
