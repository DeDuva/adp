import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { validationErrors } from "./validation-errors.js";
import { and, eq, gte, lte, desc, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "../core/git-backend.js";
import { operations } from "../db/schema.js";
import { requireScope } from "../auth/plugin.js";
import { findRepoAuthorized } from "../core/repos-lookup.js";
import { decodeCursor, encodeCursor, NEXT_CURSOR_HEADER } from "./pagination.js";
import { undoOperation } from "../core/undo.js";

const ListQuery = z.object({
  actor: z.string().uuid().optional(),
  verb: z.string().optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  path: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  cursor: z.string().optional(),
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

// History-query by path (the last outstanding M1c item):
// operations carry no path column, so this resolves the commit sha out of a
// commit-scoped target ("owner/name@<sha>", written only by change.create —
// see http-git/hooks.ts) and asks git which paths that commit actually
// touched. Only commit-scoped operations can ever match; a proposal/issue/
// candidate-set target has no path association and is filtered out.
const COMMIT_TARGET = /^[^/]+\/[^/]+@([0-9a-f]{7,40})$/;

async function matchesPath(gitBackend: GitBackend, owner: string, name: string, target: string, wantedPath: string) {
  const match = COMMIT_TARGET.exec(target);
  if (!match) return false;
  const paths = await gitBackend.commitPaths(owner, name, match[1]!);
  return paths.some((p) => p === wantedPath || p.startsWith(`${wantedPath}/`));
}

// Native plane ("/api/adp") — the op log and
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
        reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
        return;
      }
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const conditions = [eq(operations.repoId, repo.id)];
      if (parsed.data.actor) conditions.push(eq(operations.actorId, parsed.data.actor));
      if (parsed.data.verb) conditions.push(eq(operations.verb, parsed.data.verb));
      if (parsed.data.since) conditions.push(gte(operations.createdAt, new Date(parsed.data.since)));
      if (parsed.data.until) conditions.push(lte(operations.createdAt, new Date(parsed.data.until)));

      // Path filtering happens in application code (git, not SQL, knows
      // which paths a commit touched), so when it's requested the SQL side
      // over-fetches — capped, not unbounded — and gets narrowed down to
      // `limit` afterward.
      // #147: the sort key gained `id` as a tie-break, which is what makes the
      // keyset cursor below total — two operations recorded in the same
      // transaction share a `created_at` to the microsecond, and paging on the
      // timestamp alone would either repeat them or skip them. The
      // (repo_id, created_at DESC, id DESC) index matches this exactly, so the
      // filter and the ORDER BY are one ordered walk rather than a Sort over
      // the repo's whole slice.
      const pos = decodeCursor(parsed.data.cursor);
      if (pos) {
        conditions.push(sql`(${operations.createdAt}, ${operations.id}) < (${pos.createdAt}, ${pos.id})`);
      }

      const rows = await db
        .select()
        .from(operations)
        .where(and(...conditions))
        .orderBy(desc(operations.createdAt), desc(operations.id))
        .limit(parsed.data.path ? Math.max(parsed.data.limit * 10, 500) : parsed.data.limit);

      if (!parsed.data.path) {
        if (rows.length === parsed.data.limit) {
          const last = rows[rows.length - 1]!;
          reply.header(NEXT_CURSOR_HEADER, encodeCursor({ createdAt: last.createdAt, id: last.id }));
        }
        reply.send(rows.map(serializeOperation));
        return;
      }

      const wantedPath = parsed.data.path;
      const matched: (typeof operations.$inferSelect)[] = [];
      // The cursor for this branch is the last row *examined*, not the last
      // row matched. Those differ whenever the loop stops early, and paging
      // from the last match would silently skip every row between it and the
      // end of the over-fetch window — rows nothing has looked at yet.
      let lastExamined: (typeof operations.$inferSelect) | null = null;
      const overFetched = rows.length === Math.max(parsed.data.limit * 10, 500);
      for (const row of rows) {
        if (matched.length >= parsed.data.limit) break;
        lastExamined = row;
        if (await matchesPath(gitBackend, owner, repoName, row.target, wantedPath)) matched.push(row);
      }
      // Only when there is more to look at: either the scan filled its window
      // (so more rows exist beyond it) or the match loop stopped before the
      // window's end. A page that exhausted a short window has reached the end
      // of the log, and emitting a cursor there would invite a request that
      // can only come back empty.
      if (lastExamined && (overFetched || matched.length >= parsed.data.limit)) {
        reply.header(NEXT_CURSOR_HEADER, encodeCursor({ createdAt: lastExamined.createdAt, id: lastExamined.id }));
      }
      reply.send(matched.map(serializeOperation));
    },
  );

  app.get(
    "/api/adp/repos/:owner/:repo/operations/:id",
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
        .from(operations)
        .where(and(eq(operations.id, id), eq(operations.repoId, repo.id)));
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
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const [entry] = await db
        .select()
        .from(operations)
        .where(and(eq(operations.id, id), eq(operations.repoId, repo.id)));
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
