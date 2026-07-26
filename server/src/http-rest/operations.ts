import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, gte, lte, or, like, desc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "../core/git-backend.js";
import { operations } from "../db/schema.js";
import { requireScope } from "../auth/plugin.js";
import { findRepo } from "../core/repos-lookup.js";
import { undoOperation } from "../core/undo.js";

const ListQuery = z.object({
  actor: z.string().uuid().optional(),
  verb: z.string().optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

function serializeOperation(row: typeof operations.$inferSelect) {
  return {
    id: row.id,
    actor_id: row.actorId,
    verb: row.verb,
    target: row.target,
    before: row.before,
    after: row.after,
    parent_op: row.parentOp,
    created_at: row.createdAt.toISOString(),
  };
}

// Every target string this codebase writes is either exactly "owner/name"
// (repo-level ops) or "owner/name" immediately followed by '#' or '@' — so
// this is a precise repo scope, not a fuzzy prefix match: "acme/widget"
// can't accidentally match a target that starts with "acme/widget2".
// operations has no repoId column (docs/pragmatic_mvp.md's op log has been
// append-only and repo-agnostic in shape from commit 1); adding one is a
// bigger migration than this native-plane read API calls for.
function repoTargetFilter(owner: string, name: string) {
  const prefix = `${owner}/${name}`;
  return or(eq(operations.target, prefix), like(operations.target, `${prefix}#%`), like(operations.target, `${prefix}@%`));
}

// Native plane (docs/pragmatic_mvp.md Tier 4, "/api/adp") — the op log and
// undo have no GitHub analogue, so unlike everything else so far this
// isn't projected onto /api/v3 at all.
export function registerOperationRoutes(app: FastifyInstance, db: Db, gitBackend: GitBackend) {
  app.get(
    "/api/adp/repos/:owner/:repo/operations",
    { preHandler: requireScope("repo:read") },
    async (req, reply) => {
      const { owner, repo: repoName } = req.params as { owner: string; repo: string };
      const parsed = ListQuery.safeParse(req.query);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
        return;
      }
      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const conditions = [repoTargetFilter(owner, repoName)];
      if (parsed.data.actor) conditions.push(eq(operations.actorId, parsed.data.actor));
      if (parsed.data.verb) conditions.push(eq(operations.verb, parsed.data.verb));
      if (parsed.data.since) conditions.push(gte(operations.createdAt, new Date(parsed.data.since)));
      if (parsed.data.until) conditions.push(lte(operations.createdAt, new Date(parsed.data.until)));

      const rows = await db
        .select()
        .from(operations)
        .where(and(...conditions))
        .orderBy(desc(operations.createdAt))
        .limit(parsed.data.limit);

      reply.send(rows.map(serializeOperation));
    },
  );

  app.get(
    "/api/adp/repos/:owner/:repo/operations/:id",
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
        .from(operations)
        .where(and(eq(operations.id, id), repoTargetFilter(owner, repoName)));
      if (!row) {
        reply.code(404).send({ message: "Not Found" });
        return;
      }
      reply.send(serializeOperation(row));
    },
  );

  app.post(
    "/api/adp/repos/:owner/:repo/operations/:id/undo",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName, id } = req.params as { owner: string; repo: string; id: string };
      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const [entry] = await db
        .select()
        .from(operations)
        .where(and(eq(operations.id, id), repoTargetFilter(owner, repoName)));
      if (!entry) {
        reply.code(404).send({ message: "Not Found" });
        return;
      }

      const result = await undoOperation(db, gitBackend, repo, entry, req.identity!.identityId);
      if (!result.ok) {
        reply.code(422).send({ message: result.message });
        return;
      }

      const [undoOp] = await db
        .select()
        .from(operations)
        .where(eq(operations.parentOp, entry.id))
        .orderBy(desc(operations.createdAt))
        .limit(1);
      reply.send(serializeOperation(undoOp!));
    },
  );

}
