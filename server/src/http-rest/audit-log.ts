import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { validationErrors } from "./validation-errors.js";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { operations, repos } from "../db/schema.js";
import { requireScope, requireOrgAccess } from "../auth/plugin.js";
import { decodeCursor, encodeCursor, NEXT_CURSOR_HEADER } from "./pagination.js";

const AuditLogQuery = z.object({
  actor: z.string().uuid().optional(),
  verb: z.string().optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  // Higher ceiling than the per-repo operations list (200): this route's own
  // job is exporting, not paging an interactive view, and since/until is the
  // pagination mechanism for anything bigger than one page.
  limit: z.coerce.number().int().positive().max(1000).default(200),
  cursor: z.string().optional(),
  format: z.enum(["ndjson", "csv"]).default("ndjson"),
});

const CSV_HEADER = ["id", "repo_id", "actor_id", "verb", "target", "created_at"];

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(fields: string[]): string {
  return `${fields.map(csvField).join(",")}\n`;
}

// M4-3: "a projection of `operations`, not
// a second system" — no new storage, no new write path, this is a read over
// data that already exists and is already the audit trail (`operations` IS
// the op log AGENTS.md's own invariant requires every write path to use).
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
        reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
        return;
      }

      // #147: R+1 indexed reads, not one predicate no index can serve.
      //
      // "Belongs to this org" is two facts — through one of the org's repos,
      // or directly for an org-LEVEL verb (#97) — and spelling that
      // `repo_id IN (…) OR org_id = …` measured at 1M rows as a sequential
      // scan plus a sort of the whole table: 73.8 ms, 21367 blocks. Rewriting
      // it as two indexed reads unioned does not help either (71.8 ms,
      // measured): Postgres will not turn `repo_id = ANY(…)` into an ordered
      // scan, because one index walk cannot yield rows for many leading-column
      // values in sorted order.
      //
      // A LATERAL makes each repo its own `repo_id = <const>` walk, which the
      // (repo_id, created_at DESC, id DESC) index serves directly and which
      // LIMIT stops early. R+1 bounded reads, merged and re-limited: 4.2 ms
      // and 8211 blocks, with no schema change and no denormalized column.
      // (Carrying `org_id` on every row is faster still — 17 blocks — and was
      // tried and reverted; see this route's migration, 0031. It puts a
      // foreign-key lock on one row per tenant into the write path of every
      // push.)
      //
      // Every filter and the cursor go *inside* each branch, not outside: a
      // branch that took its newest 200 rows and then filtered would return
      // nothing for a repo whose recent operations are all the wrong verb.
      const pos = decodeCursor(parsed.data.cursor);
      const narrow = (alias: string) => {
        const parts = [sql.raw("TRUE")];
        if (parsed.data.actor) parts.push(sql`${sql.raw(alias)}.actor_id = ${parsed.data.actor}`);
        if (parsed.data.verb) parts.push(sql`${sql.raw(alias)}.verb = ${parsed.data.verb}`);
        if (parsed.data.since) parts.push(sql`${sql.raw(alias)}.created_at >= ${new Date(parsed.data.since)}`);
        if (parsed.data.until) parts.push(sql`${sql.raw(alias)}.created_at <= ${new Date(parsed.data.until)}`);
        if (pos) {
          parts.push(
            sql`(${sql.raw(alias)}.created_at, ${sql.raw(alias)}.id) < (${pos.createdAt}, ${pos.id})`,
          );
        }
        return sql.join(parts, sql` AND `);
      };

      const limit = parsed.data.limit;
      const { rows } = await db.execute<typeof operations.$inferSelect & { created_at: Date }>(sql`
        SELECT * FROM (
          SELECT scoped.* FROM (SELECT id FROM repos WHERE org_id = ${orgId}) r
          CROSS JOIN LATERAL (
            SELECT * FROM operations o
            WHERE o.repo_id = r.id AND ${narrow("o")}
            ORDER BY o.created_at DESC, o.id DESC
            LIMIT ${limit}
          ) scoped
          UNION ALL
          SELECT ol.* FROM operations ol
          WHERE ol.org_id = ${orgId} AND ${narrow("ol")}
          ORDER BY created_at DESC, id DESC
          LIMIT ${limit}
        ) u
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT ${limit}
      `);

      // Raw SQL, so the rows come back snake_cased and dates come back as
      // dates — normalised here rather than at each of the two call sites
      // below.
      const serialized = rows.map((r) => ({
        id: r.id as string,
        repoId: (r as Record<string, unknown>).repo_id as string | null,
        actorId: (r as Record<string, unknown>).actor_id as string,
        verb: r.verb as string,
        target: r.target as string,
        before: r.before,
        after: r.after,
        parentOp: (r as Record<string, unknown>).parent_op as string | null,
        createdAt: new Date((r as Record<string, unknown>).created_at as string),
      }));

      // #147: an export bigger than one page had only since/until to page
      // with, which is lossy across rows sharing a timestamp. The cursor is
      // the same keyset idiom every other native-plane list uses, in the same
      // header, so the body shape is unchanged.
      if (serialized.length === limit) {
        const last = serialized[serialized.length - 1]!;
        reply.header(NEXT_CURSOR_HEADER, encodeCursor({ createdAt: last.createdAt, id: last.id }));
      }

      if (parsed.data.format === "csv") {
        const body = serialized
          .map((r) => csvRow([r.id, r.repoId ?? "", r.actorId, r.verb, r.target, r.createdAt.toISOString()]))
          .join("");
        reply.type("text/csv").send(csvRow(CSV_HEADER) + body);
        return;
      }

      const body = serialized
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
      reply.type("application/x-ndjson").send(serialized.length ? `${body}\n` : "");
    },
  );
}
