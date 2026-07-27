import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { candidateSets, proposals } from "../db/schema.js";
import { requireScope } from "../auth/plugin.js";
import { findRepo } from "../core/repos-lookup.js";
import { openCandidateSet, selectCandidate, listCandidates } from "../core/candidate-sets.js";

const OpenCandidateSetBody = z.object({
  intent_id: z.string().uuid(),
  selection_policy: z.string().min(1).default("manual"),
});

const SelectCandidateBody = z.object({
  proposal_id: z.string().uuid(),
});

function serializeCandidateSet(row: typeof candidateSets.$inferSelect) {
  return {
    id: row.id,
    intent_id: row.intentId,
    selection_policy: row.selectionPolicy,
    selected_proposal_id: row.selectedProposalId,
    created_at: row.createdAt.toISOString(),
  };
}

// Native plane (docs/pragmatic_mvp.md §2.2) — no GitHub analogue. A
// candidate set is opened for an intent; proposals join it by passing
// `candidate_set_id` at creation (http-rest/proposals.ts); selecting a
// winner records which proposal that is, it doesn't merge or close the rest.
export function registerCandidateSetRoutes(app: FastifyInstance, db: Db) {
  app.post(
    "/api/adp/repos/:owner/:repo/candidate-sets",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName } = req.params as { owner: string; repo: string };
      const parsed = OpenCandidateSetBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
        return;
      }
      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const result = await openCandidateSet(
        db,
        { id: repo.id, owner, name: repoName },
        parsed.data.intent_id,
        parsed.data.selection_policy,
        req.identity!.identityId,
      );
      if (!result.ok) {
        reply.code(422).send({ message: result.message });
        return;
      }
      reply.code(201).send({ ...serializeCandidateSet(result.candidateSet), candidates: [] });
    },
  );

  app.get(
    "/api/adp/repos/:owner/:repo/candidate-sets/:id",
    { preHandler: requireScope("repo:read") },
    async (req, reply) => {
      const { owner, repo: repoName, id } = req.params as { owner: string; repo: string; id: string };
      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }
      const [row] = await db
        .select()
        .from(candidateSets)
        .where(and(eq(candidateSets.id, id), eq(candidateSets.repoId, repo.id)));
      if (!row) {
        reply.code(404).send({ message: "Not Found" });
        return;
      }
      const candidates = await listCandidates(db, id);
      reply.send({
        ...serializeCandidateSet(row),
        candidates: candidates.map((c) => ({ id: c.id, number: c.number, title: c.title, state: c.state })),
      });
    },
  );

  app.post(
    "/api/adp/repos/:owner/:repo/candidate-sets/:id/select",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName, id } = req.params as { owner: string; repo: string; id: string };
      const parsed = SelectCandidateBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
        return;
      }
      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const result = await selectCandidate(
        db,
        { id: repo.id, owner, name: repoName },
        id,
        parsed.data.proposal_id,
        req.identity!.identityId,
      );
      if (!result.ok) {
        reply.code(422).send({ message: result.message });
        return;
      }
      reply.send(serializeCandidateSet(result.candidateSet));
    },
  );
}
