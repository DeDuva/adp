import { and, eq, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { gateJobs, repos, orgs } from "../db/schema.js";
import { recordOperation } from "./operations.js";

export interface EnqueueGateJobParams {
  repoId: string;
  owner: string;
  repoName: string;
  gitSha: string;
  name: string;
  image: string;
  command: string;
  timeoutMs: number;
  actorId: string;
}

// Shared by the explicit REST enqueue route (http-rest/gate-jobs.ts,
// M4-9a) and M4-9c's auto-enqueue-on-push (http-git/hooks.ts) — one insert
// path, so a job that came from a human's POST and one that came from
// adp.yaml's `runner.gates` are indistinguishable to everything downstream
// (the queue, the runner, gate_results).
export async function enqueueGateJob(db: Db, params: EnqueueGateJobParams): Promise<typeof gateJobs.$inferSelect> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(gateJobs)
      .values({
        repoId: params.repoId,
        gitSha: params.gitSha,
        name: params.name,
        image: params.image,
        command: params.command,
        timeoutMs: params.timeoutMs,
        actorId: params.actorId,
      })
      .returning();

    await recordOperation(tx, {
      repoId: params.repoId,
      actorId: params.actorId,
      verb: "gate_job.enqueue",
      target: `${params.owner}/${params.repoName}@${params.gitSha}#${params.name}`,
      after: { status: "queued" },
    });

    return row!;
  });
}

// M4-9d: the org-scoped concurrency cap (orgs.maxConcurrentGateJobs, same
// "null is unlimited" convention as M4-3's maxConcurrentWorkspaces),
// enforced at claim time rather than enqueue time — a queue can grow
// arbitrarily deep; this bounds how much of it *executes* at once, which is
// what actually costs CPU/memory on the runner fleet.
//
// A naive "check only the oldest queued job's org, refuse the whole claim
// if it's over cap" would starve every other org's queue behind one org
// that simply has a lot of work in flight, so the cap is a condition on
// candidate selection itself, not a post-hoc rejection: skip queued jobs
// whose org is currently at its running-job ceiling and consider the
// next-oldest one instead, all inside the same `FOR UPDATE SKIP LOCKED`
// transaction mirror-poller.ts's idiom already uses.
// #92: the slack a lease allows past the job's own wall-clock timeout — a
// live runner enforces timeout_ms on the container and then still needs to
// report; a runner that hasn't reported this long after the deadline is
// presumed dead and its claim is up for reaping.
export const GATE_JOB_LEASE_GRACE_MS = 60_000;

// `claimedBy` is the runner's self-reported label (observability only);
// `claimedByIdentityId` is the authenticated identity the claim happened
// under, which is what checkout/complete's ownership check trusts (#88).
// The claim is recorded in the operation log in the same transaction (#92,
// audit §P1-5) — it is the one lifecycle transition an incident review
// needs (which runner took the job, and when) and was the only unrecorded
// one.
// The candidate selection, exported so the #93 regression test can run it
// inside a transaction of its own against a deliberately-held repos lock.
// `excludeIds` lets claimGateJob's admission loop move past a candidate
// whose org turned out to be at its cap under the lock (#94).
export async function selectClaimCandidate(tx: Pick<Db, "select">, excludeIds: string[] = []) {
  const [candidate] = await tx
    .select({ id: gateJobs.id, timeoutMs: gateJobs.timeoutMs, orgId: repos.orgId })
    .from(gateJobs)
    .innerJoin(repos, eq(gateJobs.repoId, repos.id))
    .where(
      and(
        eq(gateJobs.status, "queued"),
        excludeIds.length > 0 ? notInArray(gateJobs.id, excludeIds) : undefined,
        sql`(
          ${repos.orgId} is null
          or not exists (
            select 1 from ${orgs}
            where ${orgs.id} = ${repos.orgId}
              and ${orgs.maxConcurrentGateJobs} is not null
              and (
                select count(*) from ${gateJobs}
                inner join ${repos} as running_repo on running_repo.id = ${gateJobs.repoId}
                where running_repo.org_id = ${repos.orgId} and ${gateJobs.status} = 'running'
              ) >= ${orgs.maxConcurrentGateJobs}
          )
        )`,
      ),
    )
    .orderBy(gateJobs.createdAt)
    .limit(1)
    // `of: gateJobs`, not a bare FOR UPDATE (#93, audit §P1-2): without OF,
    // Postgres locks rows from every table in FROM — including the joined
    // repos row — and, worse, SKIP LOCKED then also *skips* a candidate
    // whose repos row someone else has locked. Issue and proposal number
    // assignment (http-rest/issues.ts, proposals.ts) each hold
    // `select id from repos ... for update` while they compute a number,
    // so under the bare form, creating an issue starved that repo's gate
    // queue for the duration — and the claim conversely held the repos
    // row lock against them. The queue's mutual exclusion is about
    // gate_jobs rows only; lock exactly those.
    .for("update", { of: gateJobs, skipLocked: true });
  return candidate ?? null;
}

export async function claimGateJob(
  db: Db,
  claimedBy: string,
  claimedByIdentityId: string,
): Promise<typeof gateJobs.$inferSelect | null> {
  return await db.transaction(async (tx) => {
    // #94 (audit §P1-3): the cap condition inside selectClaimCandidate is a
    // cheap pre-filter, not the authority — two concurrent claims can both
    // evaluate it at count = cap - 1 and both pass, because SKIP LOCKED
    // prevents taking the same *row*, not the same *budget*. The authority
    // is the recount below, taken while holding FOR UPDATE on the org row:
    // same-org admissions serialize there, so the running count a claim
    // admits against already includes every admission that beat it. A
    // candidate whose org turns out to be at cap under the lock is excluded
    // and the next-oldest considered — same no-starvation rule the
    // pre-filter applies, one candidate later.
    const excluded: string[] = [];
    let candidate: Awaited<ReturnType<typeof selectClaimCandidate>> = null;
    for (let i = 0; i < 10 && !candidate; i++) {
      const next = await selectClaimCandidate(tx, excluded);
      if (!next) return null;

      if (next.orgId !== null) {
        await tx.execute(sql`select id from ${orgs} where id = ${next.orgId} for update`);
        const [org] = await tx
          .select({ maxConcurrentGateJobs: orgs.maxConcurrentGateJobs })
          .from(orgs)
          .where(eq(orgs.id, next.orgId));
        if (org?.maxConcurrentGateJobs != null) {
          const [running] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(gateJobs)
            .innerJoin(repos, eq(gateJobs.repoId, repos.id))
            .where(and(eq(repos.orgId, next.orgId), eq(gateJobs.status, "running")));
          if ((running?.n ?? 0) >= org.maxConcurrentGateJobs) {
            excluded.push(next.id);
            continue;
          }
        }
      }
      candidate = next;
    }
    if (!candidate) return null;

    const now = new Date();
    const [row] = await tx
      .update(gateJobs)
      .set({
        status: "running",
        claimedBy,
        claimedByIdentityId,
        startedAt: now,
        leaseExpiresAt: new Date(now.getTime() + candidate.timeoutMs + GATE_JOB_LEASE_GRACE_MS),
        attempts: sql`${gateJobs.attempts} + 1`,
      })
      .where(eq(gateJobs.id, candidate.id))
      .returning();

    await recordOperation(tx, {
      repoId: row!.repoId,
      actorId: claimedByIdentityId,
      verb: "gate_job.claim",
      target: `${row!.repoId}@${row!.gitSha}#${row!.name}`,
      after: { claimed_by: claimedBy, attempt: row!.attempts, lease_expires_at: row!.leaseExpiresAt?.toISOString() },
    });

    return row!;
  });
}
