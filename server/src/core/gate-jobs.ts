import type { Db } from "../db/client.js";
import { gateJobs } from "../db/schema.js";
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
