import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PerPageQuery } from "./pagination.js";
import { validationErrors } from "./validation-errors.js";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { webhooks } from "../db/schema.js";
import { requireScope } from "../auth/plugin.js";
import { findRepoAuthorized } from "../core/repos-lookup.js";
import type { WebhookEventType } from "../core/webhooks.js";
import { encryptCredential } from "../core/mirror-crypto.js";
import { recordOperation } from "../core/operations.js";

const WEBHOOK_EVENTS: [WebhookEventType, ...WebhookEventType[]] = ["push", "pull_request", "gate_result"];

const CreateWebhookBody = z.object({
  active: z.boolean().default(true),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).default(["push"]),
  config: z.object({
    url: z.string().url(),
    secret: z.string().min(1),
  }),
});

// Never echoes `secret` back — same as GitHub's own hooks API, and the same
// reason tokens.ts never re-serializes a token hash: a write-only field.
function serializeWebhook(hook: typeof webhooks.$inferSelect) {
  return {
    id: hook.id,
    name: "web",
    active: hook.active,
    events: hook.events,
    config: { url: hook.targetUrl, content_type: "json" },
    created_at: hook.createdAt.toISOString(),
  };
}

// Outbound webhook management, GitHub-shaped (docs/pragmatic_mvp.md M2).
// Delivery mechanics (signing, retry) live in core/webhooks.ts; this is
// just the subscription CRUD other mutation routes' emitWebhookEvent calls
// read from.
export function registerWebhookRoutes(app: FastifyInstance, db: Db, credentialKey: string) {
  app.post("/api/v3/repos/:owner/:repo/hooks", { preHandler: requireScope("repo:write") }, async (req, reply) => {
    const { owner, repo: repoName } = req.params as { owner: string; repo: string };
    const parsed = CreateWebhookBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
      return;
    }
    const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }

    const hook = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(webhooks)
        .values({
          repoId: repo.id,
          targetUrl: parsed.data.config.url,
          secretCiphertext: encryptCredential(parsed.data.config.secret, credentialKey),
          events: parsed.data.events,
          active: parsed.data.active,
        })
        .returning();

      // Pointing a signed feed of repository activity at an arbitrary URL is
      // exactly the kind of act an audit log exists to record — and M4's
      // audit-log export is a projection of this table, so a write path that
      // skips it is a hole in that export. `secret` is never recorded, same
      // reason serializeWebhook never returns it.
      await recordOperation(tx, {
        repoId: repo.id,
        actorId: req.identity!.identityId,
        verb: "webhook.create",
        target: `${owner}/${repoName}@webhook:${row!.id}`,
        after: { id: row!.id, url: row!.targetUrl, events: row!.events, active: row!.active, secret: { configured: true } },
      });

      return row!;
    });

    reply.code(201).send(serializeWebhook(hook));
  });

  app.get("/api/v3/repos/:owner/:repo/hooks", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: repoName } = req.params as { owner: string; repo: string };
    const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }
    // #97: bounded like every other compat-plane list.
    const { per_page, page } = PerPageQuery.parse(req.query ?? {});
    const rows = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.repoId, repo.id))
      .orderBy(asc(webhooks.createdAt))
      .limit(per_page)
      .offset((page - 1) * per_page);
    reply.send(rows.map(serializeWebhook));
  });

  app.get(
    "/api/v3/repos/:owner/:repo/hooks/:hookId",
    { preHandler: requireScope("repo:read") },
    async (req, reply) => {
      const { owner, repo: repoName, hookId } = req.params as { owner: string; repo: string; hookId: string };
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }
      const [hook] = await db
        .select()
        .from(webhooks)
        .where(and(eq(webhooks.id, hookId), eq(webhooks.repoId, repo.id)));
      if (!hook) {
        reply.code(404).send({ message: "Not Found" });
        return;
      }
      reply.send(serializeWebhook(hook));
    },
  );

  app.delete(
    "/api/v3/repos/:owner/:repo/hooks/:hookId",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName, hookId } = req.params as { owner: string; repo: string; hookId: string };
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }
      const deleted = await db.transaction(async (tx) => {
        const rows = await tx
          .delete(webhooks)
          .where(and(eq(webhooks.id, hookId), eq(webhooks.repoId, repo.id)))
          .returning();
        if (rows.length === 0) return rows;

        await recordOperation(tx, {
          repoId: repo.id,
          actorId: req.identity!.identityId,
          verb: "webhook.delete",
          target: `${owner}/${repoName}@webhook:${hookId}`,
          before: { id: rows[0]!.id, url: rows[0]!.targetUrl, events: rows[0]!.events, active: rows[0]!.active },
        });

        return rows;
      });
      if (deleted.length === 0) {
        reply.code(404).send({ message: "Not Found" });
        return;
      }
      reply.code(204).send();
    },
  );
}
