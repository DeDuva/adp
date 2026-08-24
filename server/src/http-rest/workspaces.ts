import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { KeysetQuery, decodeCursor, encodeCursor, NEXT_CURSOR_HEADER } from "./pagination.js";
import { validationErrors } from "./validation-errors.js";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "../core/git-backend.js";
import { workspaces } from "../db/schema.js";
import { requireScope } from "../auth/plugin.js";
import { findRepoAuthorized } from "../core/repos-lookup.js";
import { createWorkspace, destroyWorkspace } from "../core/workspaces.js";

const CreateWorkspaceBody = z.object({
  base_ref: z.string().min(1),
  ttl_hours: z.number().positive().optional(),
});

function serializeWorkspace(row: typeof workspaces.$inferSelect) {
  return {
    id: row.id,
    branch: row.branch,
    base_ref: row.baseRef,
    base_sha: row.baseSha,
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt?.toISOString() ?? null,
    destroyed_at: row.destroyedAt?.toISOString() ?? null,
  };
}

// Native plane — no GitHub analogue.
// A workspace is a branch with lifecycle metadata (core/workspaces.ts), not
// a new isolation mechanism.
export function registerWorkspaceRoutes(app: FastifyInstance, db: Db, gitBackend: GitBackend) {
  app.post(
    "/api/adp/repos/:owner/:repo/workspaces",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName } = req.params as { owner: string; repo: string };
      const parsed = CreateWorkspaceBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
        return;
      }
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const result = await createWorkspace(
        db,
        gitBackend,
        repo,
        parsed.data.base_ref,
        req.identity!.identityId,
        parsed.data.ttl_hours,
      );
      if (!result.ok) {
        reply.code(422).send({ message: result.message });
        return;
      }
      reply.code(201).send(serializeWorkspace(result.workspace));
    },
  );

  app.get(
    "/api/adp/repos/:owner/:repo/workspaces",
    { preHandler: requireScope("repo:read") },
    async (req, reply) => {
      const { owner, repo: repoName } = req.params as { owner: string; repo: string };
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }
      // #97: bounded, native-plane style — `limit` + keyset cursor, next
      // page's cursor in the ADP-Next-Cursor header so the body shape every
      // existing consumer reads stays exactly as it was.
      const { limit, cursor } = KeysetQuery.parse(req.query ?? {});
      const pos = decodeCursor(cursor);
      const rows = await db
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.repoId, repo.id),
            pos
              ? sql`(${workspaces.createdAt}, ${workspaces.id}) < (${pos.createdAt}, ${pos.id})`
              : undefined,
          ),
        )
        .orderBy(desc(workspaces.createdAt), desc(workspaces.id))
        .limit(limit);
      if (rows.length === limit) {
        reply.header(NEXT_CURSOR_HEADER, encodeCursor({ createdAt: rows[rows.length - 1]!.createdAt, id: rows[rows.length - 1]!.id }));
      }
      reply.send(rows.map(serializeWorkspace));
    },
  );

  app.delete(
    "/api/adp/repos/:owner/:repo/workspaces/:id",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName, id } = req.params as { owner: string; repo: string; id: string };
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }
      const result = await destroyWorkspace(db, gitBackend, repo, id, req.identity!.identityId);
      if (!result.ok) {
        reply.code(422).send({ message: result.message });
        return;
      }
      reply.code(204).send();
    },
  );

}
