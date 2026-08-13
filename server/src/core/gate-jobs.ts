import { and, eq, sql } from "drizzle-orm";
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
// `claimedBy` is the runner's self-reported label (observability only);
// `claimedByIdentityId` is the authenticated identity the claim happened
// under, which is what checkout/complete's ownership check trusts (#88).
export async function claimGateJob(
  db: Db,
  claimedBy: string,
  claimedByIdentityId: string,
): Promise<typeof gateJobs.$inferSelect | null> {
  return await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: gateJobs.id })
      .from(gateJobs)
      .innerJoin(repos, eq(gateJobs.repoId, repos.id))
      .where(
        and(
          eq(gateJobs.status, "queued"),
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
      .for("update", { skipLocked: true });
    if (!candidate) return null;

    const [row] = await tx
      .update(gateJobs)
      .set({ status: "running", claimedBy, claimedByIdentityId, startedAt: new Date() })
      .where(eq(gateJobs.id, candidate.id))
      .returning();
    return row!;
  });
}
