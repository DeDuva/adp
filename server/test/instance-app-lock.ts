import type pg from "pg";

// Two test files cannot both own the instance's GitHub App.
//
// `github_apps` holds **one row per instance** — that is the design (#232): the
// App is this deployment's identity to GitHub, and `findGitHubApp` reads the
// table rather than a repository's column. So a suite that creates one is
// asserting something about the whole instance, and two suites doing it at once
// against one database are not independent: each `beforeEach` clears the table
// the other is mid-test on, and each lookup can find the other's App.
//
// It surfaced as `e2e-check-runs.test.ts` failing with "Cannot read properties
// of undefined" in the clean-room job while passing everywhere else, which is
// what a race looks like from the outside — and the local suite had passed it
// twice, because the two files happened not to overlap.
//
// **A Postgres advisory lock is the mutex, because vitest has no cross-file
// one.** `describe.sequential` orders tests inside a file and says nothing about
// files; `fileParallelism: false` would serialise the whole suite to fix two
// files. This codebase already reaches for advisory locks where two writers must
// not overlap — the migration runner and the gate-job tick — so it is the
// idiomatic answer here rather than a novel one.
//
// The lock is held on **one dedicated connection**, not on the pool. A pool
// hands out a different connection per query, and `pg_advisory_unlock` on a
// connection that never took the lock is a silent no-op — which would leave the
// lock held until the process exits and the next file blocked for its whole run.

/** Distinct from the migration runner's 727_001; arbitrary beyond that. */
const INSTANCE_APP_LOCK = 727_239;

export interface InstanceAppLock {
  release: () => Promise<void>;
}

/**
 * Take exclusive use of the instance's GitHub App for this file.
 *
 * Blocks until whichever other suite holds it has finished. That is a few
 * seconds of waiting in exchange for a suite that does not fail one run in
 * some number, which is the trade every serialisation here makes.
 */
export async function lockInstanceApp(pool: pg.Pool): Promise<InstanceAppLock> {
  const client = await pool.connect();
  await client.query("SELECT pg_advisory_lock($1)", [INSTANCE_APP_LOCK]);
  return {
    release: async () => {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [INSTANCE_APP_LOCK]);
      } finally {
        // Released even if the unlock threw: a connection returned to the pool
        // drops its session locks anyway, and a leaked client is the one
        // failure that would outlive the run.
        client.release();
      }
    },
  };
}
