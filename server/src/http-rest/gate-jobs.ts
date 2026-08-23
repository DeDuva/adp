import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { KeysetQuery, decodeCursor, encodeCursor, NEXT_CURSOR_HEADER } from "./pagination.js";
import { validationErrors } from "./validation-errors.js";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "../core/git-backend.js";
import type { Signer } from "../core/signing.js";
import { gateJobs, repos } from "../db/schema.js";
import { requireScope } from "../auth/plugin.js";
import { recordOperation } from "../core/operations.js";
import { findRepoAuthorized, findRepoById } from "../core/repos-lookup.js";
import { enqueueGateJob, claimGateJob } from "../core/gate-jobs.js";
import { recordGateResultIn, emitGateResultWebhook, type RecordGateResultParams } from "../core/gate-results.js";
import { recordGateJobCompletion } from "../core/telemetry.js";
import { checkStorageQuota } from "../core/storage-usage.js";

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

// gate_jobs.status (queue lifecycle) -> gate_results.status (the verdict
// land policy actually reads). timed_out and error are both "did not
// produce success" as far as gates_green is concerned — the distinction
// between them is preserved on the gate_jobs row itself, not lost, just not
// meaningful to a land-policy check that only knows success/failure/pending.
function toGateResultStatus(status: "succeeded" | "failed" | "timed_out" | "error"): "success" | "failure" {
  return status === "succeeded" ? "success" : "failure";
}

// M4-9a: the queue mechanism. M4-9c adds
// the checkout endpoint (a real runner needs the code it's about to test)
// and wires a completed job into a real, signed `gate_results` row — the
// thing land policy actually reads — via core/gate-results.ts, the same
// shape http-rest/gates.ts's self-report route produces.
//
// Deliberately more than one CRUD resource: enqueue and the repo-scoped
// listing need `repo:write`/`repo:read` (whoever can push code can request
// or see a gate run on it); claim, complete, and checkout are instance-wide
// and need the new "runner" scope (auth/plugin.ts) instead — a runner
// process serves the whole instance, not one repo, and must not be handed
// repo:write just to pull work. This is also what keeps a compromised
// runner host's blast radius bounded: it can claim/complete/checkout gate
// jobs, never touch Postgres directly, and — per the ownership check the
// checkout and complete routes below share — only ever read the one
// repo/sha of a job *its own identity* claimed, and only ever complete
// those same jobs, not any org's. (Until #88 that check didn't exist:
// status === "running" was the only guard, so any runner token could
// checkout or complete any org's claimed job.)
export function registerGateJobRoutes(
  app: FastifyInstance,
  db: Db,
  gitBackend: GitBackend,
  signer: Signer,
  publicUrl: string,
  credentialKey: string,
) {
  app.post(
    "/api/adp/repos/:owner/:repo/gate-jobs",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName } = req.params as { owner: string; repo: string };
      const parsed = EnqueueBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
        return;
      }

      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const row = await enqueueGateJob(db, {
        repoId: repo.id,
        owner,
        repoName,
        gitSha: parsed.data.git_sha,
        name: parsed.data.name,
        image: parsed.data.image,
        command: parsed.data.command,
        timeoutMs: parsed.data.timeout_ms,
        actorId: req.identity!.identityId,
      });

      reply.code(201).send(serializeGateJob(row));
    },
  );

  app.get(
    "/api/adp/repos/:owner/:repo/gate-jobs",
    { preHandler: requireScope("repo:read") },
    async (req, reply) => {
      const { owner, repo: repoName } = req.params as { owner: string; repo: string };
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      // #97: real pagination (limit + keyset cursor in ADP-Next-Cursor)
      // instead of a silent 200-row truncation — and no inline `logs`: a
      // page of jobs each carrying up to 1MB of logs made the listing cost
      // whatever its noisiest job cost. Logs stay on the single-job
      // responses (claim, complete), where one job is the point.
      const { limit, cursor } = KeysetQuery.parse(req.query ?? {});
      const pos = decodeCursor(cursor);
      const rows = await db
        .select()
        .from(gateJobs)
        .where(
          and(
            eq(gateJobs.repoId, repo.id),
            pos ? sql`(${gateJobs.createdAt}, ${gateJobs.id}) < (${pos.createdAt}, ${pos.id})` : undefined,
          ),
        )
        .orderBy(desc(gateJobs.createdAt), desc(gateJobs.id))
        .limit(limit);
      if (rows.length === limit) {
        reply.header(
          NEXT_CURSOR_HEADER,
          encodeCursor({ createdAt: rows[rows.length - 1]!.createdAt, id: rows[rows.length - 1]!.id }),
        );
      }

      reply.send({ gate_jobs: rows.map((row) => ({ ...serializeGateJob(row), logs: undefined })) });
    },
  );

  // Instance-wide: a runner doesn't know or care which repo it's about to
  // work on, only that it wants the oldest queued job whose org (if any)
  // isn't already at its M4-9d concurrency cap. See core/gate-jobs.ts's
  // claimGateJob for why that's a selection condition, not a post-hoc
  // rejection.
  app.post("/api/adp/gate-jobs/claim", { preHandler: requireScope("runner") }, async (req, reply) => {
    const parsed = ClaimBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
      return;
    }

    const claimed = await claimGateJob(db, parsed.data.claimed_by, req.identity!.identityId);

    if (!claimed) {
      reply.code(204).send();
      return;
    }
    reply.code(200).send(serializeGateJob(claimed));
  });

  // The ownership check checkout and complete share (#88): the caller must
  // be the identity that claimed the job. `claimedBy` deliberately can't
  // serve here — it's a client-supplied label any runner token could echo —
  // so the comparison is against claimed_by_identity_id, which claimGateJob
  // recorded from the *authenticated* claim request. A running row where
  // it's null (claimed before the column existed) fails closed: without it
  // there is no way to know the owner, and guessing open is how this was a
  // cross-tenant land-policy bypass.
  function claimHeldByCaller(job: typeof gateJobs.$inferSelect, callerIdentityId: string): boolean {
    return job.claimedByIdentityId !== null && job.claimedByIdentityId === callerIdentityId;
  }

  // A tarball of the job's own repo/sha — nothing else. Bounded to jobs
  // currently `running` *and claimed by the calling identity*: an unclaimed
  // or already-completed job's code is not fetchable here, and neither is
  // another runner's claimed job, so the window in which the "runner" scope
  // grants any read access to a repo's contents at all is the same narrow
  // window the caller itself is actively working that job in.
  app.get("/api/adp/gate-jobs/:id/checkout", { preHandler: requireScope("runner") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [job] = await db.select().from(gateJobs).where(eq(gateJobs.id, id));
    if (!job) {
      reply.code(404).send({ message: `Gate job ${id} not found` });
      return;
    }
    if (job.status !== "running") {
      reply.code(409).send({ message: `Gate job ${id} is '${job.status}', not currently claimed` });
      return;
    }
    if (!claimHeldByCaller(job, req.identity!.identityId)) {
      reply.code(403).send({ message: `Gate job ${id} was claimed by a different runner` });
      return;
    }

    const repo = await findRepoById(db, job.repoId);
    if (!repo) {
      reply.code(404).send({ message: `Repository for gate job ${id} not found` });
      return;
    }

    const tar = await gitBackend.archiveTar(repo.owner, repo.name, job.gitSha);
    reply.type("application/x-tar").send(tar);
  });

  app.post("/api/adp/gate-jobs/:id/complete", { preHandler: requireScope("runner") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = CompleteBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
      return;
    }

    const [existing] = await db.select().from(gateJobs).where(eq(gateJobs.id, id));
    if (!existing) {
      reply.code(404).send({ message: `Gate job ${id} not found` });
      return;
    }
    // Two distinct refusals: a job that isn't running has no claimant to
    // complete it (still "queued" means never claimed; already terminal
    // means completed once, and neither should silently re-write history),
    // and a running job may only be completed by the identity that claimed
    // it — completion writes signed gate evidence that land policy trusts,
    // so any other runner token "completing" it would be a land-policy
    // bypass (#88).
    if (existing.status !== "running") {
      reply.code(409).send({ message: `Gate job ${id} is '${existing.status}', not claimable for completion` });
      return;
    }
    if (!claimHeldByCaller(existing, req.identity!.identityId)) {
      reply.code(403).send({ message: `Gate job ${id} was claimed by a different runner` });
      return;
    }

    // M4-3: the one growth path that must NOT be refused when the org is over
    // its storage ceiling. The gate has already run; refusing the completion
    // would leave the job `running` until the reaper (#92) times it out, the
    // signed evidence would never be written, and a `gates_green` land policy
    // would block that commit permanently — a storage quota turning into a
    // land outage. So the completion always lands, and it is the *logs* that
    // are dropped: up to 1 MB of inline text (schema.ts's own comment calls
    // this out as waiting on M4-8), against a few hundred bytes for the
    // status and the evidence that land policy actually reads. Dropping is
    // recorded on the operation, so "why are this job's logs empty" is
    // answerable from the op log and the audit export rather than a mystery.
    const jobRepo = await findRepoById(db, existing.repoId);
    const logsQuota = await checkStorageQuota(db, jobRepo?.orgId ?? null);
    const logs = logsQuota.ok ? (parsed.data.logs ?? null) : null;
    const logsDropped = !logsQuota.ok && (parsed.data.logs ?? null) !== null;

    // #95 (audit §P1-4): the status flip, its operation, AND the signed
    // evidence commit or roll back together. The evidence used to be a
    // second transaction after this one — a crash between the two left a
    // terminal job with no gate_results row and no way to re-drive it
    // (complete refuses non-running jobs), which for a gates_green land
    // policy meant that commit was permanently blocked. Now a failure
    // anywhere in here (the signer included) leaves the job `running`, and
    // the runner's normal retry of /complete produces both records or
    // neither. The repo lookup rides inside too: a repo deleted between
    // claim and complete still completes the job, minus evidence there is
    // no repo left for gates_green to check against anyway.
    const { row, evidenceParams } = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(gateJobs)
        .set({
          status: parsed.data.status,
          exitCode: parsed.data.exit_code ?? null,
          logs,
          finishedAt: new Date(),
        })
        .where(eq(gateJobs.id, id))
        .returning();

      await recordOperation(tx, {
        repoId: row!.repoId,
        actorId: req.identity!.identityId,
        verb: "gate_job.complete",
        target: `${row!.repoId}@${row!.gitSha}#${row!.name}`,
        after: { status: parsed.data.status, ...(logsDropped ? { logs_dropped: "org storage quota" } : {}) },
      });

      const [repo] = await tx.select().from(repos).where(eq(repos.id, row!.repoId));
      let evidenceParams: RecordGateResultParams | null = null;
      if (repo) {
        evidenceParams = {
          repoId: row!.repoId,
          owner: repo.owner,
          repoName: repo.name,
          gitSha: row!.gitSha,
          name: row!.name,
          status: toGateResultStatus(row!.status as "succeeded" | "failed" | "timed_out" | "error"),
          summary: `gate runner: ${row!.status}${row!.exitCode !== null ? ` (exit ${row!.exitCode})` : ""}`,
          reporterId: req.identity!.identityId,
          reporterPrincipal: req.identity!.principal,
          externalId: `gate_job:${row!.id}`,
        };
        await recordGateResultIn(tx, signer, publicUrl, evidenceParams);
      }

      return { row: row!, evidenceParams };
    });

    // Post-commit side effects only from here down: the process-local
    // completion counter (a metric that could roll back with the
    // transaction would be the tail wagging the dog) and the webhook
    // announcing evidence that has actually committed.
    recordGateJobCompletion(row.status);
    if (evidenceParams) {
      emitGateResultWebhook(db, evidenceParams, req.log, credentialKey);
    }

    reply.send(serializeGateJob(row));
  });
}
