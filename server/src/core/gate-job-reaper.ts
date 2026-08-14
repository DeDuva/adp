import { and, asc, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { gateJobs } from "../db/schema.js";
import { recordOperation } from "./operations.js";
import { recordGateJobCompletion } from "./telemetry.js";

const BATCH_SIZE = 50;

// One more claim than MAX_ATTEMPTS is never handed out: a job whose lease
// has expired MAX_ATTEMPTS times has consumed real runner time each time,
// and "the gate script hangs past its own timeout" is at least as likely as
// "three runners in a row happened to die". Marking it `error` is the
// honest terminal state — the runner could not run the gate to completion —
// and `error` is exactly what gates_green refuses to treat as success.
export const GATE_JOB_MAX_ATTEMPTS = 3;

// #92 (audit §P1-1): the recovery path the bespoke queue shipped without.
// A runner that died after claiming used to leave its job `running`
// forever, with three compounding effects: the gate never reported, so
// gates_green blocked that commit's land permanently; the job permanently
// held one slot of its org's maxConcurrentGateJobs; and complete 409s on a
// non-running job, so there was no recovery short of psql.
//
// Same claim-then-act shape as workspace-sweeper.ts (FOR UPDATE SKIP LOCKED
// batch, so concurrent ticks — or a second API replica running its own
// reaper — never process the same row twice), except the whole batch's
// writes stay inside the claiming transaction: each expiry decision is a
// pure row update plus its op-log entry, so unlike the workspace sweep
// there is no external side effect that must not hold a row lock.
//
// The decision per expired job: attempts < cap → back to `queued`, claim
// fields cleared, so any live runner picks it up fresh (the requeue does
// not bypass the org concurrency cap — a requeued job re-enters claim's
// candidate selection like any other). At the cap → terminal `error`, and
// the completion counter ticks so the dashboards see the failure the same
// way they'd see a runner-reported one. Both outcomes write an operation
// row: the queue's lifecycle transitions are exactly what an incident
// review replays.
export async function sweepExpiredGateJobs(
  db: Db,
  actorId: string,
): Promise<{ requeued: number; errored: number }> {
  return await db.transaction(async (tx) => {
    const expired = await tx
      .select()
      .from(gateJobs)
      .where(and(eq(gateJobs.status, "running"), lt(gateJobs.leaseExpiresAt, new Date())))
      .orderBy(asc(gateJobs.leaseExpiresAt))
      .limit(BATCH_SIZE)
      .for("update", { skipLocked: true });

    let requeued = 0;
    let errored = 0;
    for (const job of expired) {
      const target = `${job.repoId}@${job.gitSha}#${job.name}`;
      if (job.attempts < GATE_JOB_MAX_ATTEMPTS) {
        await tx
          .update(gateJobs)
          .set({ status: "queued", claimedBy: null, claimedByIdentityId: null, startedAt: null, leaseExpiresAt: null })
          .where(eq(gateJobs.id, job.id));
        await recordOperation(tx, {
          repoId: job.repoId,
          actorId,
          verb: "gate_job.requeue",
          target,
          after: { reason: "lease_expired", attempt: job.attempts, previously_claimed_by: job.claimedBy },
        });
        requeued++;
      } else {
        await tx
          .update(gateJobs)
          .set({
            status: "error",
            finishedAt: new Date(),
            logs: sql`coalesce(${gateJobs.logs}, '') || ${`\n[reaper] lease expired on attempt ${job.attempts} of ${GATE_JOB_MAX_ATTEMPTS}; marked error`}`,
          })
          .where(eq(gateJobs.id, job.id));
        await recordOperation(tx, {
          repoId: job.repoId,
          actorId,
          verb: "gate_job.expire",
          target,
          after: { reason: "lease_expired", attempts: job.attempts, previously_claimed_by: job.claimedBy },
        });
        // The dashboards count terminal outcomes off this counter; a job the
        // reaper errored is as terminal as one a runner reported.
        recordGateJobCompletion("error");
        errored++;
      }
    }
    return { requeued, errored };
  });
}

// Same shape as startWorkspaceSweeper: an interval owned by main.ts, with a
// real system identity so the operations it records name their actor.
export function startGateJobReaper(db: Db, actorId: string, intervalMs: number): NodeJS.Timeout {
  return setInterval(() => {
    sweepExpiredGateJobs(db, actorId).catch((err) => {
      console.error("gate-job reaper tick failed:", err);
    });
  }, intervalMs);
}
