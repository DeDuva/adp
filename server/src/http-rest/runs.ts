import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { validationErrors } from "./validation-errors.js";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "../core/git-backend.js";
import type { Signer } from "../core/signing.js";
import { requireScope } from "../auth/plugin.js";
import { findRepoAuthorized } from "../core/repos-lookup.js";
import { runs, sessions } from "../db/schema.js";
import { verifyEnvelope, decodeStatement, type DsseEnvelope } from "../core/dsse.js";
import { KeyRegistry } from "../core/signing.js";
import {
  openRun,
  closeRun,
  abandonRun,
  runChains,
  runStats,
  runTrajectory,
  compareRuns,
  trajectoryDigest,
  serializeRun,
} from "../core/runs.js";
import { serializeEvent, verifyChain, emitterContiguity, EVENT_KINDS } from "../core/trajectory.js";
import { recordEval, listEvals, serializeEval } from "../core/evals.js";

const OpenRunBody = z.object({
  intent_id: z.string().uuid(),
  // Opaque, like `sessions.harness` — "squad", "swarm", something that does not
  // exist yet. ADP never branches on the value.
  orchestrator: z.string().min(1),
  external_ref: z.string().min(1).optional(),
  // Open-time only, and there is deliberately no route that updates them: they
  // ride in the run attestation, so a label that could change afterwards would
  // put the envelope and the row into disagreement.
  labels: z.record(z.string()).optional(),
});

const CloseRunBody = z.object({
  final_git_sha: z.string().regex(/^[0-9a-f]{40}$/),
});

const AbandonRunBody = z.object({
  reason: z.string().default(""),
});

const RecordEvalBody = z.object({
  name: z.string().min(1),
  passed: z.boolean(),
  score: z.number().finite().optional(),
  summary: z.string().optional(),
  // Either the eval definition itself (digested here) or a digest the caller
  // already computed. One of the two is what makes the result reproducible.
  spec: z.unknown().optional(),
  spec_digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  gate_name: z.string().min(1).optional(),
  git_sha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  metrics: z.record(z.unknown()).optional(),
});

function parseKinds(raw: unknown): string[] | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const kinds = raw.split(",").filter((k) => (EVENT_KINDS as readonly string[]).includes(k));
  return kinds.length > 0 ? kinds : undefined;
}

// The run plane: an orchestrator's unit of assigned work, the sessions it spawned,
// the trajectory they produced, and the eval that scored the result.
//
// Native plane only (`/api/adp/...`) — GitHub has no analogue, and per A18 this
// hangs off `operations`, `changes`, and `gate_results` rather than off proposals.
export function registerRunRoutes(
  app: FastifyInstance,
  db: Db,
  gitBackend: GitBackend,
  signer: Signer,
  publicUrl: string,
  // #102: verify resolves envelope keyids through the registry, so runs
  // attested before a key rotation still verify after it.
  keyRegistry: KeyRegistry = new KeyRegistry(signer),
) {
  async function repoOr404(
    req: { params: unknown; identity?: import("../auth/tokens.js").AuthenticatedIdentity },
    reply: { code: (n: number) => { send: (b: unknown) => void } },
  ) {
    const { owner, repo: repoName } = req.params as { owner: string; repo: string };
    const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return null;
    }
    return { id: repo.id, owner, name: repoName };
  }

  app.post("/api/adp/repos/:owner/:repo/runs", { preHandler: requireScope("repo:write") }, async (req, reply) => {
    const parsed = OpenRunBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
      return;
    }
    const repo = await repoOr404(req, reply);
    if (!repo) return;

    const result = await openRun(
      db,
      repo,
      {
        intentId: parsed.data.intent_id,
        orchestrator: parsed.data.orchestrator,
        externalRef: parsed.data.external_ref ?? null,
        ...(parsed.data.labels ? { labels: parsed.data.labels } : {}),
      },
      req.identity!.identityId,
    );
    if (!result.ok) {
      reply.code(result.status).send({ message: result.message });
      return;
    }
    // 200 rather than 201 when an existing run was returned: an orchestrator
    // retrying after a crash can tell whether it opened the run or rejoined it.
    reply.code(result.created ? 201 : 200).send(serializeRun(result.run));
  });

  app.get("/api/adp/repos/:owner/:repo/runs", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const repo = await repoOr404(req, reply);
    if (!repo) return;
    const query = req.query as { intent_id?: string; status?: string; limit?: string };

    const filters = [eq(runs.repoId, repo.id)];
    if (query.intent_id) filters.push(eq(runs.intentId, query.intent_id));
    if (query.status === "open" || query.status === "closed" || query.status === "abandoned") {
      filters.push(eq(runs.status, query.status));
    }

    const rows = await db
      .select()
      .from(runs)
      .where(and(...filters))
      .orderBy(desc(runs.createdAt))
      .limit(Math.min(Number(query.limit ?? 50) || 50, 200));

    reply.send({ runs: rows.map(serializeRun) });
  });

  // Registered before `/:runId` for readability; Fastify's router prefers the
  // static segment regardless of declaration order.
  app.get("/api/adp/repos/:owner/:repo/runs/compare", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const repo = await repoOr404(req, reply);
    if (!repo) return;
    const query = req.query as { intent_id?: string; eval?: string; limit?: string };

    const comparisons = await compareRuns(db, repo.id, {
      intentId: query.intent_id,
      evalName: query.eval,
      limit: Number(query.limit ?? 50) || 50,
    });
    reply.send({ intent_id: query.intent_id ?? null, runs: comparisons });
  });

  app.get("/api/adp/repos/:owner/:repo/runs/:runId", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const repo = await repoOr404(req, reply);
    if (!repo) return;
    const { runId } = req.params as { runId: string };

    const [run] = await db.select().from(runs).where(and(eq(runs.id, runId), eq(runs.repoId, repo.id)));
    if (!run) {
      reply.code(404).send({ message: "Not Found" });
      return;
    }

    const sessionRows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.runId, runId))
      .orderBy(sessions.createdAt);
    const chains = await runChains(db, runId);
    const heads = new Map(chains.map((c) => [c.sessionId, c]));

    reply.send({
      ...serializeRun(run),
      sessions: sessionRows.map((s) => ({
        id: s.id,
        harness: s.harness,
        status: s.status,
        workspace_id: s.workspaceId,
        resumed_from_session_id: s.resumedFromSessionId,
        event_count: heads.get(s.id)?.count ?? 0,
        chain_head: heads.get(s.id)?.head ?? null,
        created_at: s.createdAt.toISOString(),
      })),
      evals: (await listEvals(db, runId)).map(serializeEval),
    });
  });

  app.post(
    "/api/adp/repos/:owner/:repo/runs/:runId/close",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const parsed = CloseRunBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
        return;
      }
      const repo = await repoOr404(req, reply);
      if (!repo) return;
      const { runId } = req.params as { runId: string };

      const result = await closeRun(
        db,
        gitBackend,
        signer,
        publicUrl,
        repo,
        runId,
        { finalGitSha: parsed.data.final_git_sha },
        req.identity!.identityId,
      );
      if (!result.ok) {
        reply.code(result.status).send({ message: result.message });
        return;
      }
      reply.send({
        ...serializeRun(result.run),
        sessions: result.chains.map((c) => ({ id: c.sessionId, event_count: c.count, chain_head: c.head })),
        closed_sessions: result.closedSessions,
        already_closed: result.alreadyClosed,
      });
    },
  );

  app.post(
    "/api/adp/repos/:owner/:repo/runs/:runId/abandon",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const parsed = AbandonRunBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
        return;
      }
      const repo = await repoOr404(req, reply);
      if (!repo) return;
      const { runId } = req.params as { runId: string };

      const result = await abandonRun(db, repo, runId, parsed.data.reason, req.identity!.identityId);
      if (!result.ok) {
        reply.code(result.status).send({ message: result.message });
        return;
      }
      reply.send(serializeRun(result.run));
    },
  );

  app.get(
    "/api/adp/repos/:owner/:repo/runs/:runId/trajectory",
    { preHandler: requireScope("repo:read") },
    async (req, reply) => {
      const repo = await repoOr404(req, reply);
      if (!repo) return;
      const { runId } = req.params as { runId: string };
      const query = req.query as { kinds?: string; limit?: string; offset?: string };

      const [run] = await db.select().from(runs).where(and(eq(runs.id, runId), eq(runs.repoId, repo.id)));
      if (!run) {
        reply.code(404).send({ message: "Not Found" });
        return;
      }

      const { events, total } = await runTrajectory(db, runId, {
        kinds: parseKinds(query.kinds),
        limit: Number(query.limit ?? 200) || 200,
        offset: Number(query.offset ?? 0) || 0,
      });
      reply.send({ run_id: runId, total, events: events.map(serializeEvent) });
    },
  );

  app.get(
    "/api/adp/repos/:owner/:repo/runs/:runId/stats",
    { preHandler: requireScope("repo:read") },
    async (req, reply) => {
      const repo = await repoOr404(req, reply);
      if (!repo) return;
      const { runId } = req.params as { runId: string };

      const [run] = await db.select().from(runs).where(and(eq(runs.id, runId), eq(runs.repoId, repo.id)));
      if (!run) {
        reply.code(404).send({ message: "Not Found" });
        return;
      }
      reply.send(await runStats(db, runId));
    },
  );

  // Recomputes every chain from the stored rows and checks the run attestation
  // against them. Without this the hash chain is a claim; with it, it is a claim
  // anyone holding a read token can falsify.
  app.get(
    "/api/adp/repos/:owner/:repo/runs/:runId/verify",
    { preHandler: requireScope("repo:read") },
    async (req, reply) => {
      const repo = await repoOr404(req, reply);
      if (!repo) return;
      const { runId } = req.params as { runId: string };

      const [run] = await db.select().from(runs).where(and(eq(runs.id, runId), eq(runs.repoId, repo.id)));
      if (!run) {
        reply.code(404).send({ message: "Not Found" });
        return;
      }

      const sessionRows = await db.select().from(sessions).where(eq(sessions.runId, runId));
      const chainResults = await Promise.all(sessionRows.map((s) => verifyChain(db, s.id)));
      const chainsOk = chainResults.every((c) => c.ok);

      // Two different guarantees, deliberately reported separately: the chain
      // says the events ADP holds were not edited, the emitter counter says ADP
      // was given all of them. A run can pass the first and fail the second.
      const contiguity = new Map(
        await Promise.all(
          sessionRows.map(async (s) => [s.id, await emitterContiguity(db, s.id)] as const),
        ),
      );
      const emittersOk = [...contiguity.values()].every((c) => !c.tracked || c.complete);

      const chains = sessionRows.map((s) => {
        const verified = chainResults.find((c) => c.sessionId === s.id)!;
        return { sessionId: s.id, harness: s.harness, count: verified.count, head: verified.head };
      });
      const recomputedDigest = trajectoryDigest(chains);

      let envelopeVerified: boolean | null = null;
      let digestMatches: boolean | null = null;
      let subjectSha: string | null = null;
      if (run.envelope) {
        const envelope = run.envelope as DsseEnvelope;
        envelopeVerified = verifyEnvelope(keyRegistry, envelope);
        const statement = decodeStatement(envelope);
        const predicate = statement.predicate as { trajectoryDigest?: string };
        digestMatches = predicate.trajectoryDigest === recomputedDigest;
        subjectSha = statement.subject[0]?.digest.sha1 ?? null;
      }

      reply.send({
        run_id: runId,
        // The single answer. False whenever any part below is false, so a caller
        // that reads one field is not reading an optimistic one — including a
        // chain that verifies perfectly but is missing events the emitter
        // numbered and never delivered.
        ok: chainsOk && emittersOk && envelopeVerified !== false && digestMatches !== false,
        chains_ok: chainsOk,
        emitters_ok: emittersOk,
        envelope_verified: envelopeVerified,
        trajectory_digest_matches: digestMatches,
        recomputed_trajectory_digest: recomputedDigest,
        attested_trajectory_digest: run.trajectoryDigest,
        final_git_sha: run.finalGitSha,
        attested_subject_sha: subjectSha,
        sessions: chainResults.map((c) => {
          const emitter = contiguity.get(c.sessionId)!;
          return {
            session_id: c.sessionId,
            ok: c.ok,
            event_count: c.count,
            head: c.head,
            broke_at_seq: c.brokeAtSeq,
            reason: c.reason,
            emitter_tracked: emitter.tracked,
            emitter_complete: emitter.complete,
            emitter_first_gap: emitter.firstGap,
          };
        }),
        // Who scored this run, and whether that was somebody other than whoever
        // ran it.
        evals: (await listEvals(db, runId)).map((e) => ({
          id: e.id,
          name: e.name,
          reporter_principal: e.reporterPrincipal,
          separately_authorized: e.separatelyAuthorized,
        })),
      });
    },
  );

  app.post(
    "/api/adp/repos/:owner/:repo/runs/:runId/evals",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const parsed = RecordEvalBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
        return;
      }
      const repo = await repoOr404(req, reply);
      if (!repo) return;
      const { runId } = req.params as { runId: string };

      const result = await recordEval(
        db,
        signer,
        publicUrl,
        repo,
        runId,
        {
          name: parsed.data.name,
          passed: parsed.data.passed,
          score: parsed.data.score,
          summary: parsed.data.summary,
          spec: parsed.data.spec,
          specDigest: parsed.data.spec_digest,
          gateName: parsed.data.gate_name,
          gitSha: parsed.data.git_sha,
          metrics: parsed.data.metrics,
        },
        { identityId: req.identity!.identityId, principal: req.identity!.principal },
      );
      if (!result.ok) {
        reply.code(result.status).send({ message: result.message });
        return;
      }

      reply.code(201).send({
        ...serializeEval(result.eval),
        gate: {
          id: result.gateResult.id,
          name: result.gateResult.name,
          status: result.gateResult.status,
          git_sha: result.gateResult.gitSha,
          envelope: result.gateResult.envelope,
        },
      });
    },
  );

  app.get(
    "/api/adp/repos/:owner/:repo/runs/:runId/evals",
    { preHandler: requireScope("repo:read") },
    async (req, reply) => {
      const repo = await repoOr404(req, reply);
      if (!repo) return;
      const { runId } = req.params as { runId: string };

      const [run] = await db.select().from(runs).where(and(eq(runs.id, runId), eq(runs.repoId, repo.id)));
      if (!run) {
        reply.code(404).send({ message: "Not Found" });
        return;
      }
      reply.send({ run_id: runId, evals: (await listEvals(db, runId)).map(serializeEval) });
    },
  );
}
