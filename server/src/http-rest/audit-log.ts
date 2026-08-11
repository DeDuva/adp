import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { operations, repos } from "../db/schema.js";
import { requireScope, requireOrgAccess } from "../auth/plugin.js";

const AuditLogQuery = z.object({
  actor: z.string().uuid().optional(),
  verb: z.string().optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  // Higher ceiling than the per-repo operations list (200): this route's own
  // job is exporting, not paging an interactive view, and since/until is the
  // pagination mechanism for anything bigger than one page.
  limit: z.coerce.number().int().positive().max(1000).default(200),
  format: z.enum(["ndjson", "csv"]).default("ndjson"),
});

const CSV_HEADER = ["id", "repo_id", "actor_id", "verb", "target", "created_at"];

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(fields: string[]): string {
  return `${fields.map(csvField).join(",")}\n`;
}

// M4-3 (docs/m4-readiness-review.md §4): "a projection of `operations`, not
// a second system" — no new storage, no new write path, this is a read over
// data that already exists and is already the audit trail (`operations` IS
// the op log CLAUDE.md's own invariant requires every write path to use).
// The one real design decision is scope: an org's audit log spans every repo
// in it, so this joins on `repos.orgId` rather than the single-repo
// operations route it otherwise mirrors.
//
// The first real route requireOrgAccess (auth/plugin.ts, M4-1) drives — it
// was built with no consumer yet; this is that consumer.
export function registerAuditLogRoutes(app: FastifyInstance, db: Db) {
  app.get(
    "/api/adp/orgs/:orgId/audit-log",
    { preHandler: [requireScope("repo:read"), requireOrgAccess(db, "orgId")] },
    async (req, reply) => {
      const { orgId } = req.params as { orgId: string };
      const parsed = AuditLogQuery.safeParse(req.query);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
        return;
      }

      const orgRepos = await db.select({ id: repos.id }).from(repos).where(eq(repos.orgId, orgId));
      const orgRepoIds = orgRepos.map((r) => r.id);

      // An org with no repos yet has an empty, valid audit log — not an
      // error, and not an empty inArray() call, which drizzle refuses.
      const rows =
        orgRepoIds.length === 0
          ? []
          : await db
              .select()
              .from(operations)
              .where(
                and(
                  inArray(operations.repoId, orgRepoIds),
                  parsed.data.actor ? eq(operations.actorId, parsed.data.actor) : undefined,
                  parsed.data.verb ? eq(operations.verb, parsed.data.verb) : undefined,
                  parsed.data.since ? gte(operations.createdAt, new Date(parsed.data.since)) : undefined,
                  parsed.data.until ? lte(operations.createdAt, new Date(parsed.data.until)) : undefined,
                ),
              )
              .orderBy(desc(operations.createdAt))
              .limit(parsed.data.limit);

      if (parsed.data.format === "csv") {
        const body = rows
          .map((r) => csvRow([r.id, r.repoId ?? "", r.actorId, r.verb, r.target, r.createdAt.toISOString()]))
          .join("");
        reply.type("text/csv").send(csvRow(CSV_HEADER) + body);
        return;
      }

      const body = rows
        .map((r) =>
          JSON.stringify({
            id: r.id,
            repo_id: r.repoId,
            actor_id: r.actorId,
            verb: r.verb,
            target: r.target,
            before: r.before,
            after: r.after,
            parent_op: r.parentOp,
            created_at: r.createdAt.toISOString(),
          }),
        )
        .join("\n");
      reply.type("application/x-ndjson").send(rows.length ? `${body}\n` : "");
    },
  );
}
