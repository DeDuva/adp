import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { gateJobs } from "../db/schema.js";
import { requireScope } from "../auth/plugin.js";
import { recordOperation } from "../core/operations.js";
import { findRepo } from "../core/repos-lookup.js";

const EnqueueBody = z.object({
  git_sha: z.string().regex(/^[0-9a-f]{40}$/),
  name: z.string().min(1),
  image: z.string().min(1),
  command: z.string().min(1),
  timeout_ms: z.number().int().positive().max(30 * 60 * 1000).default(5 * 60 * 1000),
});

const ClaimBody = z.object({
  claimed_by: z.string().min(1),
});

const CompleteBody = z.object({
  status: z.enum(["succeeded", "failed", "timed_out", "error"]),
  exit_code: z.number().int().optional(),
  // Same bound as sessions' trajectory blobs elsewhere in http-rest — inline
  // storage (schema.ts's gateJobs.logs comment) needs a ceiling until M4-8
  // gives this an object-store pointer to use instead.
  logs: z.string().max(1_000_000).optional(),
});

function serializeGateJob(row: typeof gateJobs.$inferSelect) {
  return {
    id: row.id,
    repo_id: row.repoId,
    git_sha: row.gitSha,
    name: row.name,
    image: row.image,
    command: row.command,
    timeout_ms: row.timeoutMs,
    status: row.status,
    actor_id: row.actorId,
    claimed_by: row.claimedBy,
    exit_code: row.exitCode,
    logs: row.logs,
    created_at: row.createdAt.toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    finished_at: row.finishedAt?.toISOString() ?? null,
  };
}

// M4-9a (docs/m4-readiness-review.md §4): the queue mechanism only — no
// runner exists yet. Proven end-to-end by e2e tests acting as a stub runner
// over HTTP, the same substrate a real one (M4-9b, the `runner/` package)
// will use.
//
// Deliberately three routes rather than one CRUD resource: enqueue is
// repo-scoped and needs `repo:write` (whoever can push code can request a
// gate run on it); claim and complete are instance-wide and need the new
// "runner" scope (auth/plugin.ts) instead — a runner process serves the
// whole instance, not one repo, and must not be handed `repo:write` just to
// report results. This is also what keeps a compromised runner host's blast
// radius to "can claim and complete gate jobs", never touching Postgres
// directly or holding a repo-scoped credential (the `cli/`-style
// pure-HTTP-client boundary, chosen for this exact reason).
export function registerGateJobRoutes(app: FastifyInstance, db: Db) {
  app.post(
    "/api/adp/repos/:owner/:repo/gate-jobs",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName } = req.params as { owner: string; repo: string };
      const parsed = EnqueueBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
        return;
      }

      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const row = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(gateJobs)
          .values({
            repoId: repo.id,
            gitSha: parsed.data.git_sha,
            name: parsed.data.name,
            image: parsed.data.image,
            command: parsed.data.command,
            timeoutMs: parsed.data.timeout_ms,
            actorId: req.identity!.identityId,
          })
          .returning();

        await recordOperation(tx, {
          repoId: repo.id,
          actorId: req.identity!.identityId,
          verb: "gate_job.enqueue",
          target: `${owner}/${repoName}@${parsed.data.git_sha}#${parsed.data.name}`,
          after: { status: "queued" },
        });

        return row!;
      });

      reply.code(201).send(serializeGateJob(row));
    },
  );

  app.get(
    "/api/adp/repos/:owner/:repo/gate-jobs",
    { preHandler: requireScope("repo:read") },
    async (req, reply) => {
      const { owner, repo: repoName } = req.params as { owner: string; repo: string };
      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const rows = await db
        .select()
        .from(gateJobs)
        .where(eq(gateJobs.repoId, repo.id))
        .orderBy(desc(gateJobs.createdAt))
        .limit(200);

      reply.send({ gate_jobs: rows.map(serializeGateJob) });
    },
  );

  // Instance-wide: a runner doesn't know or care which repo it's about to
  // work on, only that it wants the oldest queued job. `FOR UPDATE SKIP
  // LOCKED` (mirror-poller.ts, workspace-sweeper.ts's established idiom)
  // makes this safe with more than one runner polling concurrently.
  app.post("/api/adp/gate-jobs/claim", { preHandler: requireScope("runner") }, async (req, reply) => {
    const parsed = ClaimBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
      return;
    }

    const claimed = await db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({ id: gateJobs.id })
        .from(gateJobs)
        .where(eq(gateJobs.status, "queued"))
        .orderBy(gateJobs.createdAt)
        .limit(1)
        .for("update", { skipLocked: true });
      if (!candidate) return null;

      const [row] = await tx
        .update(gateJobs)
        .set({ status: "running", claimedBy: parsed.data.claimed_by, startedAt: new Date() })
        .where(eq(gateJobs.id, candidate.id))
        .returning();
      return row!;
    });

    if (!claimed) {
      reply.code(204).send();
      return;
    }
    reply.code(200).send(serializeGateJob(claimed));
  });

  app.post("/api/adp/gate-jobs/:id/complete", { preHandler: requireScope("runner") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = CompleteBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
      return;
    }

    const [existing] = await db.select().from(gateJobs).where(eq(gateJobs.id, id));
    if (!existing) {
      reply.code(404).send({ message: `Gate job ${id} not found` });
      return;
    }
    // Only a job this runner actually claimed can be completed — a job still
    // "queued" was never claimed, and a job already terminal was already
    // completed once (by this runner or another). Neither should silently
    // re-write history.
    if (existing.status !== "running") {
      reply.code(409).send({ message: `Gate job ${id} is '${existing.status}', not claimable for completion` });
      return;
    }

    const row = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(gateJobs)
        .set({
          status: parsed.data.status,
          exitCode: parsed.data.exit_code ?? null,
          logs: parsed.data.logs ?? null,
          finishedAt: new Date(),
        })
        .where(eq(gateJobs.id, id))
        .returning();

      await recordOperation(tx, {
        repoId: row!.repoId,
        actorId: req.identity!.identityId,
        verb: "gate_job.complete",
        target: `${row!.repoId}@${row!.gitSha}#${row!.name}`,
        after: { status: parsed.data.status },
      });

      return row!;
    });

    reply.send(serializeGateJob(row));
  });
}
