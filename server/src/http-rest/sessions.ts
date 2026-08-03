import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import type { GitBackend } from "../core/git-backend.js";
import type { Signer } from "../core/signing.js";
import { requireScope } from "../auth/plugin.js";
import { findRepo } from "../core/repos-lookup.js";
import {
  startSession,
  createCheckpoint,
  resumeSession,
  closeSession,
  listCheckpoints,
  sessionLineage,
  type SessionRow,
  type CheckpointRow,
} from "../core/sessions.js";

const StartSessionBody = z.object({
  // Free-form on purpose: ADP never branches on the value, which is what makes
  // the protocol harness-neutral rather than harness-aware. "claude-code",
  // "openhands", or something that doesn't exist yet are all equally valid.
  harness: z.string().min(1),
  intent_id: z.string().uuid().optional(),
  workspace_id: z.string().uuid().optional(),
});

const CheckpointBody = z.object({
  git_sha: z.string().regex(/^[0-9a-f]{40}$/),
  harness: z.string().min(1).optional(),
  // Opaque to ADP. Never parsed, never validated beyond "it is JSON" — a
  // harness storing its own format must not need an ADP change to do so.
  state: z.unknown().default(null),
});

const ResumeBody = z.object({
  harness: z.string().min(1),
  checkpoint_id: z.string().uuid().optional().describe("Defaults to the session's latest checkpoint"),
});

function serializeSession(row: SessionRow) {
  return {
    id: row.id,
    harness: row.harness,
    intent_id: row.intentId,
    workspace_id: row.workspaceId,
    status: row.status,
    resumed_from_session_id: row.resumedFromSessionId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function serializeCheckpoint(row: CheckpointRow) {
  return {
    id: row.id,
    session_id: row.sessionId,
    seq: row.seq,
    git_sha: row.gitSha,
    harness: row.harness,
    state: row.state,
    // The envelope is the evidence, not a projection of it — returned whole so
    // a caller can verify a checkpoint without trusting this server's summary
    // of it, same as the evidence bundle does for gate results.
    envelope: row.envelope,
    created_at: row.createdAt.toISOString(),
  };
}

// M3 (D2, docs/m3-readiness-review.md M3-3): session state as a first-class ADP
// object, so a task started under one harness can be resumed under another with
// one continuous signed history.
//
// Native plane only — there is no GitHub analogue, and per A18 sessions hang off
// `operations` and `changes` rather than off `proposal`, which is a compat-plane
// shape that may erode.
export function registerSessionRoutes(
  app: FastifyInstance,
  db: Db,
  gitBackend: GitBackend,
  signer: Signer,
  publicUrl: string,
) {
  app.post(
    "/api/adp/repos/:owner/:repo/sessions",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName } = req.params as { owner: string; repo: string };
      const parsed = StartSessionBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
        return;
      }
      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const result = await startSession(
        db,
        { id: repo.id, owner, name: repoName },
        { harness: parsed.data.harness, intentId: parsed.data.intent_id, workspaceId: parsed.data.workspace_id },
        req.identity!.identityId,
      );
      if (!result.ok) {
        reply.code(result.status).send({ message: result.message });
        return;
      }
      reply.code(201).send(serializeSession(result.session));
    },
  );

  app.get(
    "/api/adp/repos/:owner/:repo/sessions/:id",
    { preHandler: requireScope("repo:read") },
    async (req, reply) => {
      const { owner, repo: repoName, id } = req.params as { owner: string; repo: string; id: string };
      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const lineage = await sessionLineage(db, repo.id, id);
      if (lineage.length === 0) {
        reply.code(404).send({ message: "Not Found" });
        return;
      }

      const session = lineage[lineage.length - 1]!;
      reply.send({
        ...serializeSession(session),
        // The whole chain back to the session that started the work, so a
        // caller never has to walk resumed_from_session_id by hand to answer
        // "where did this come from".
        lineage: lineage.map(serializeSession),
        checkpoints: (await listCheckpoints(db, session.id)).map(serializeCheckpoint),
      });
    },
  );

  app.post(
    "/api/adp/repos/:owner/:repo/sessions/:id/checkpoints",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName, id } = req.params as { owner: string; repo: string; id: string };
      const parsed = CheckpointBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
        return;
      }
      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const result = await createCheckpoint(
        db,
        gitBackend,
        signer,
        publicUrl,
        { id: repo.id, owner, name: repoName },
        id,
        { gitSha: parsed.data.git_sha, harness: parsed.data.harness, state: parsed.data.state },
        req.identity!.identityId,
      );
      if (!result.ok) {
        reply.code(result.status).send({ message: result.message });
        return;
      }
      reply.code(201).send(serializeCheckpoint(result.checkpoint));
    },
  );

  app.get(
    "/api/adp/repos/:owner/:repo/sessions/:id/checkpoints",
    { preHandler: requireScope("repo:read") },
    async (req, reply) => {
      const { owner, repo: repoName, id } = req.params as { owner: string; repo: string; id: string };
      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }
      const lineage = await sessionLineage(db, repo.id, id);
      if (lineage.length === 0) {
        reply.code(404).send({ message: "Not Found" });
        return;
      }
      reply.send((await listCheckpoints(db, id)).map(serializeCheckpoint));
    },
  );

  app.post(
    "/api/adp/repos/:owner/:repo/sessions/:id/resume",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName, id } = req.params as { owner: string; repo: string; id: string };
      const parsed = ResumeBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
        return;
      }
      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const result = await resumeSession(
        db,
        gitBackend,
        signer,
        { id: repo.id, owner, name: repoName },
        id,
        { harness: parsed.data.harness, checkpointId: parsed.data.checkpoint_id },
        req.identity!.identityId,
      );
      if (!result.ok) {
        reply.code(result.status).send({ message: result.message });
        return;
      }

      reply.code(201).send({
        ...serializeSession(result.session),
        resumed_from: {
          session_id: result.previousSessionId,
          checkpoint_id: result.checkpoint.id,
          git_sha: result.checkpoint.gitSha,
          harness: result.checkpoint.harness,
        },
        workspace: { id: result.workspace.id, branch: result.workspace.branch },
      });
    },
  );

  app.post(
    "/api/adp/repos/:owner/:repo/sessions/:id/close",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName, id } = req.params as { owner: string; repo: string; id: string };
      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }
      const result = await closeSession(db, { id: repo.id, owner, name: repoName }, id, req.identity!.identityId);
      if (!result.ok) {
        reply.code(result.status).send({ message: result.message });
        return;
      }
      reply.send(serializeSession(result.session));
    },
  );
}
