import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { validationErrors } from "./validation-errors.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { KeysetQuery, decodeCursor, encodeCursor, NEXT_CURSOR_HEADER } from "./pagination.js";
import type { Db } from "../db/client.js";
import { candidateSets, proposals } from "../db/schema.js";
import { requireScope } from "../auth/plugin.js";
import { findRepoAuthorized } from "../core/repos-lookup.js";
import {
  openCandidateSet,
  selectCandidate,
  listCandidates,
  resolveCandidateSet,
  candidateScore,
} from "../core/candidate-sets.js";
import { latestGateResults } from "../core/gate-results-lookup.js";
import type { GitBackend } from "../core/git-backend.js";
import type { Signer } from "../core/signing.js";
import type { LandRequirement } from "../core/repo-policy.js";

const OpenCandidateSetBody = z.object({
  intent_id: z.string().uuid(),
  // Constrained to the policies core/candidate-sets.ts implements. It used to
  // be free text, which meant a typo'd policy was accepted at open time and
  // only discovered — as an unknown-policy error — when the set tried to
  // resolve, long after the fan-out had been paid for.
  selection_policy: z.enum(["manual", "first_green", "best_score"]).default("manual"),
});

const SelectCandidateBody = z.object({
  proposal_id: z.string().uuid(),
});

const ResolveCandidateSetBody = z.object({
  // Optional override: resolve this specific candidate regardless of policy.
  // Required in practice for `manual` sets that haven't called /select.
  proposal_id: z.string().uuid().optional(),
});

function serializeCandidateSet(row: typeof candidateSets.$inferSelect) {
  return {
    id: row.id,
    intent_id: row.intentId,
    selection_policy: row.selectionPolicy,
    selected_proposal_id: row.selectedProposalId,
    status: row.status,
    resolved_at: row.resolvedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

// Native plane (docs/pragmatic_mvp.md §2.2) — no GitHub analogue. A
// candidate set is opened for an intent; proposals join it by passing
// `candidate_set_id` at creation (http-rest/proposals.ts); selecting a
// winner records which proposal that is, it doesn't merge or close the rest.
export function registerCandidateSetRoutes(
  app: FastifyInstance,
  db: Db,
  // Resolution lands the winner, so this route family now needs everything the
  // merge path needs. Kept optional-with-defaults for the same reason
  // proposals.ts does: existing test apps that only open and select shouldn't
  // have to start constructing a land environment.
  gitBackend: GitBackend,
  instanceFloor: LandRequirement[] = [],
  sbom?: { signer: Signer; publicUrl: string },
) {
  app.post(
    "/api/adp/repos/:owner/:repo/candidate-sets",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName } = req.params as { owner: string; repo: string };
      const parsed = OpenCandidateSetBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
        return;
      }
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
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
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
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
      // The comparison view (D1's "money shot") needs each candidate's head sha,
      // its score, and its gate verdicts side by side — otherwise a reader can
      // see that one candidate won but not *why*, which is the whole question a
      // 50-way fan-out raises.
      const candidates = await listCandidates(db, id);
      const enriched = await Promise.all(
        candidates.map(async (c) => {
          const latest = await latestGateResults(db, repo.id, c.headSha);
          return {
            id: c.id,
            number: c.number,
            title: c.title,
            state: c.state,
            head_ref: c.headRef,
            head_sha: c.headSha,
            score: await candidateScore(db, repo.id, c.headSha),
            gates: [...latest.values()].map((g) => ({ name: g.name, status: g.status, summary: g.summary })),
          };
        }),
      );

      reply.send({ ...serializeCandidateSet(row), candidates: enriched });
    },
  );

  // Listing sets is what makes the comparison view reachable at all — before
  // this, a set could only be fetched by an id the caller already had.
  app.get(
    "/api/adp/repos/:owner/:repo/candidate-sets",
    { preHandler: requireScope("repo:read") },
    async (req, reply) => {
      const { owner, repo: repoName } = req.params as { owner: string; repo: string };
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }
      // #97: bounded — limit + keyset cursor in the ADP-Next-Cursor header.
      const { limit, cursor } = KeysetQuery.parse(req.query ?? {});
      const pos = decodeCursor(cursor);
      const rows = await db
        .select()
        .from(candidateSets)
        .where(
          and(
            eq(candidateSets.repoId, repo.id),
            pos ? sql`(${candidateSets.createdAt}, ${candidateSets.id}) < (${pos.createdAt}, ${pos.id})` : undefined,
          ),
        )
        .orderBy(desc(candidateSets.createdAt), desc(candidateSets.id))
        .limit(limit);
      if (rows.length === limit) {
        reply.header(
          NEXT_CURSOR_HEADER,
          encodeCursor({ createdAt: rows[rows.length - 1]!.createdAt, id: rows[rows.length - 1]!.id }),
        );
      }

      reply.send(
        await Promise.all(
          rows.map(async (row) => ({
            ...serializeCandidateSet(row),
            candidate_count: (await listCandidates(db, row.id)).length,
          })),
        ),
      );
    },
  );

  app.post(
    "/api/adp/repos/:owner/:repo/candidate-sets/:id/select",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName, id } = req.params as { owner: string; repo: string; id: string };
      const parsed = SelectCandidateBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
        return;
      }
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
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

  // M3 (D1): resolving is what makes a fan-out finish — pick the winner by the
  // set's selection policy, land it through the shared land path, and reclaim
  // the losers' workspaces. `/select` still only *records* a choice; this is
  // the call that acts on one.
  app.post(
    "/api/adp/repos/:owner/:repo/candidate-sets/:id/resolve",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName, id } = req.params as { owner: string; repo: string; id: string };
      const parsed = ResolveCandidateSetBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
        return;
      }
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const result = await resolveCandidateSet(
        { db, gitBackend, instanceFloor, sbom, logError: (message, err) => req.log.error(`${message}: ${err}`) },
        gitBackend,
        { id: repo.id, owner, name: repoName, orgId: repo.orgId },
        id,
        { identityId: req.identity!.identityId, principal: req.identity!.principal },
        parsed.data.proposal_id,
      );
      if (!result.ok) {
        reply.code(result.status).send({
          message: result.message,
          ...(result.unmet ? { unmet: result.unmet } : {}),
        });
        return;
      }

      reply.send({
        ...serializeCandidateSet(result.candidateSet),
        landed: { proposal_id: result.landed.id, number: result.landed.number, sha: result.sha },
        reclaimed: result.reclaimed.map((r) => ({ proposal_id: r.proposalId, workspace_id: r.workspaceId })),
      });
    },
  );
}
