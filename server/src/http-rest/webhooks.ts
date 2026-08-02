import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { webhooks } from "../db/schema.js";
import { requireScope } from "../auth/plugin.js";
import { findRepo } from "../core/repos-lookup.js";
import type { WebhookEventType } from "../core/webhooks.js";
import { encryptCredential } from "../core/mirror-crypto.js";

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
      reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
      return;
    }
    const repo = await findRepo(db, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }

    const [hook] = await db
      .insert(webhooks)
      .values({
        repoId: repo.id,
        targetUrl: parsed.data.config.url,
        secretCiphertext: encryptCredential(parsed.data.config.secret, credentialKey),
        events: parsed.data.events,
        active: parsed.data.active,
      })
      .returning();

    reply.code(201).send(serializeWebhook(hook!));
  });

  app.get("/api/v3/repos/:owner/:repo/hooks", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: repoName } = req.params as { owner: string; repo: string };
    const repo = await findRepo(db, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }
    const rows = await db.select().from(webhooks).where(eq(webhooks.repoId, repo.id));
    reply.send(rows.map(serializeWebhook));
  });

  app.get(
    "/api/v3/repos/:owner/:repo/hooks/:hookId",
    { preHandler: requireScope("repo:read") },
    async (req, reply) => {
      const { owner, repo: repoName, hookId } = req.params as { owner: string; repo: string; hookId: string };
      const repo = await findRepo(db, owner, repoName);
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
      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }
      const deleted = await db
        .delete(webhooks)
        .where(and(eq(webhooks.id, hookId), eq(webhooks.repoId, repo.id)))
        .returning();
      if (deleted.length === 0) {
        reply.code(404).send({ message: "Not Found" });
        return;
      }
      reply.code(204).send();
    },
  );
}
