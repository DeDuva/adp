import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { orgs, repos, sessionEvents, sessions } from "../db/schema.js";
import { recordOperation } from "./operations.js";
import { withTickLock, TICK_LOCKS } from "./tick-lock.js";

// #161: the interim retention default, and the reason there is one.
//
// PLAN.md 3-6 is the real policy and waits on bench arm 4's numbers. This
// decides only what happens in the interval — and the interval is not empty,
// because ambient capture (#149) started writing at a volume nobody had
// operated before, against an implicit promise of unbounded retention that
// nothing was ever going to keep. The first operator to notice would have
// noticed as a disk alert.
//
// **Reduce payloads, keep the chain.** That is the shape 3-6 already settled,
// so nothing here has to be unwound: an aged-out event keeps its seq, its
// links, its hash and every typed column; what goes is the payload body. The
// chain still verifies, and `verifyChain` reports how much of the range it
// could only take as recorded rather than re-derive — the third verification
// state, said out loud rather than folded into a green tick.
//
// What it costs is stated in schema.ts and in `VerifyResult.notRetained`, and
// is worth repeating once: a reduced event's typed columns stop being
// independently verifiable, because the hash covering them cannot be recomputed
// without the payload it also covers. A signed checkpoint head past them still
// pins the prefix. That is the strongest guarantee available once a preimage is
// gone.

const BATCH_SIZE = 500;

// Days. Ninety is chosen rather than derived — 3-5 is the measurement, and this
// is what happens before it. It is long enough that the window is not the thing
// an evaluator notices, and short enough to bound a runaway producer to one
// quarter of writes.
//
// **Behaviour changes on upgrade**, which is the honest cost of shipping a
// default instead of an implicit forever, and it is why the number is
// deliberately generous and the org override exists. Under the default
// `trajectory.payloads: structure` (#199) what a reduced event loses is a shape
// with the strings already replaced by their byte counts — a repository that
// opted into `payloads: full` is exactly the one that should set an override.
export const DEFAULT_RETENTION_DAYS = 90;

// Zero means "keep forever", explicitly, at either level. Not null: null is how
// an org says "whatever the instance says", and conflating the two would make
// an org that had never been configured indistinguishable from one that had
// chosen to keep everything.
export function retentionDaysFor(orgDays: number | null, instanceDays: number): number {
  return orgDays === null ? instanceDays : orgDays;
}

export function cutoffFor(days: number, now: Date = new Date()): Date | null {
  if (days <= 0) return null;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export interface ReductionResult {
  reduced: number;
  orgs: number;
}

// One org's overdue payloads, in batches.
//
// Scoped per org rather than swept globally because the window is per org, and
// a global sweep would need the window as a join condition on the largest table
// in the schema. This walks the orgs — of which there are few — and asks each
// one's question separately.
export async function reduceOrgPayloads(
  db: Db,
  org: { id: string; trajectoryRetentionDays: number | null },
  instanceDays: number,
  actorId: string,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = cutoffFor(retentionDaysFor(org.trajectoryRetentionDays, instanceDays), now);
  if (!cutoff) return 0;

  const orgRepos = await db.select({ id: repos.id }).from(repos).where(eq(repos.orgId, org.id));
  if (orgRepos.length === 0) return 0;
  const repoIds = orgRepos.map((r) => r.id);

  const orgSessions = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(inArray(sessions.repoId, repoIds));
  if (orgSessions.length === 0) return 0;
  const sessionIds = orgSessions.map((s) => s.id);

  let reduced = 0;
  for (;;) {
    // Claimed in a batch and reduced in the same statement, so a crash between
    // the two cannot leave a row selected-but-not-reduced — there is no such
    // state. `payload_retained` is the claim.
    const rows = await db
      .select({ id: sessionEvents.id })
      .from(sessionEvents)
      .where(
        and(
          inArray(sessionEvents.sessionId, sessionIds),
          // `payload_retained` is the claim, and the only one. Filtering on the
          // payload's own emptiness as well would make an event that genuinely
          // carried `{}` — a legal request, see schema.ts — indistinguishable
          // from one this has already reduced.
          eq(sessionEvents.payloadRetained, true),
          lt(sessionEvents.occurredAt, cutoff),
        ),
      )
      .orderBy(asc(sessionEvents.occurredAt))
      .limit(BATCH_SIZE);
    if (rows.length === 0) break;

    await db
      .update(sessionEvents)
      // JSON null, not SQL NULL — hence the cast rather than a plain `null`,
      // which drizzle would map to the latter. The column is `notNull()`
      // deliberately, so that an event carrying only a kind is a legal request
      // rather than a 500 the recorder cannot retry (#63). What says the
      // payload is gone is `payload_retained`, the column that exists to say it.
      .set({ payload: sql`'null'::jsonb`, payloadRetained: false })
      .where(
        inArray(
          sessionEvents.id,
          rows.map((r) => r.id),
        ),
      );
    reduced += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }

  if (reduced > 0) {
    // Recorded, because reducing what the record holds is itself a change to
    // the record, and the log is where this project says such things. An
    // operator who finds a payload gone can find out when and under what
    // window, rather than concluding the data was lost.
    await db.transaction(async (tx) => {
      await recordOperation(tx, {
        repoId: repoIds[0]!,
        orgId: org.id,
        actorId,
        verb: "trajectory.reduce",
        target: `org:${org.id}`,
        after: {
          events: reduced,
          retentionDays: retentionDaysFor(org.trajectoryRetentionDays, instanceDays),
          olderThan: cutoff.toISOString(),
        },
      });
    });
  }
  return reduced;
}

export async function reduceOverduePayloads(
  db: Db,
  instanceDays: number,
  actorId: string,
  now: Date = new Date(),
): Promise<ReductionResult> {
  const all = await db
    .select({ id: orgs.id, trajectoryRetentionDays: orgs.trajectoryRetentionDays })
    .from(orgs);

  let reduced = 0;
  let touched = 0;
  for (const org of all) {
    // One org's failure must not take the sweep down with it, the same lesson
    // the workspace sweeper learned: an unexpected throw used to leave every
    // org sorted after the broken one unswept on every subsequent tick.
    try {
      const n = await reduceOrgPayloads(db, org, instanceDays, actorId, now);
      reduced += n;
      if (n > 0) touched++;
    } catch (err) {
      console.error(`trajectory retention sweep failed for org ${org.id}:`, err);
    }
  }
  return { reduced, orgs: touched };
}

export async function retentionTick(db: Db, instanceDays: number, actorId: string): Promise<ReductionResult | null> {
  return withTickLock(db, TICK_LOCKS.trajectoryRetention, () =>
    reduceOverduePayloads(db, instanceDays, actorId),
  );
}

export function startRetentionSweeper(
  db: Db,
  instanceDays: number,
  actorId: string,
  intervalMs: number,
): () => void {
  const timer = setInterval(() => {
    void retentionTick(db, instanceDays, actorId).catch((err) => {
      console.error("trajectory retention tick failed:", err);
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// What an operator is told before it matters, rather than after. Served on the
// org console beside the storage quota it exists to bound.
export interface RetentionStatus {
  days: number;
  source: "org" | "instance";
  // Events whose payload has already been reduced, and events that the next
  // sweep will reduce — the second is what makes this a warning rather than a
  // report.
  reduced: number;
  dueNext: number;
}

export async function retentionStatusFor(
  db: Db,
  org: { id: string; trajectoryRetentionDays: number | null },
  instanceDays: number,
  now: Date = new Date(),
): Promise<RetentionStatus> {
  const days = retentionDaysFor(org.trajectoryRetentionDays, instanceDays);
  const source = org.trajectoryRetentionDays === null ? "instance" : "org";
  const cutoff = cutoffFor(days, now);

  const result = await db.execute(sql`
    select
      count(*) filter (where not e.payload_retained)::int as reduced,
      count(*) filter (
        where e.payload_retained
        and ${cutoff ? sql`e.occurred_at < ${cutoff.toISOString()}::timestamptz` : sql`false`}
      )::int as due_next
    from session_events e
    join sessions s on s.id = e.session_id
    join repos r on r.id = s.repo_id
    where r.org_id = ${org.id}::uuid
  `);
  const row = result.rows[0] as { reduced: number; due_next: number };
  return { days, source, reduced: Number(row.reduced), dueNext: Number(row.due_next) };
}
