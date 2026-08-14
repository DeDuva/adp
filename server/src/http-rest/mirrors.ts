import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { identities, mirrors, mirrorSyncLog } from "../db/schema.js";
import { requireScope } from "../auth/plugin.js";
import { recordOperation } from "../core/operations.js";
import { findRepoAuthorized } from "../core/repos-lookup.js";
import { findMirror } from "../core/mirrors-lookup.js";
import { encryptCredential } from "../core/mirror-crypto.js";

const CreateMirrorBody = z.object({
  remote_url: z.string().url(),
  direction: z.enum(["outbound", "inbound", "both"]),
  credential: z.string().min(1),
  webhook_secret: z.string().min(16).optional(),
});

function serializeMirror(mirror: typeof mirrors.$inferSelect) {
  return {
    id: mirror.id,
    remote_url: mirror.remoteUrl,
    direction: mirror.direction,
    enabled: mirror.enabled,
    last_outbound_sha: mirror.lastOutboundSha,
    last_inbound_sha: mirror.lastInboundSha,
    created_at: mirror.createdAt,
    updated_at: mirror.updatedAt,
  };
}

export function registerMirrorRoutes(app: FastifyInstance, db: Db, credentialKey: string) {
  // requireScope("admin"): stores a credential capable of writing to an
  // external GitHub repo — a materially higher bar than repo:write.
  app.post("/api/v3/repos/:owner/:repo/mirror", { preHandler: requireScope("admin") }, async (req, reply) => {
    const { owner, repo: name } = req.params as { owner: string; repo: string };
    const repo = await findRepoAuthorized(db, req.identity!, owner, name);
    if (!repo) {
      reply.code(404).send({ message: "Not Found" });
      return;
    }
    if (await findMirror(db, repo.id)) {
      reply.code(422).send({ message: `Repository ${owner}/${name} already has a mirror configured` });
      return;
    }

    const parsed = CreateMirrorBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
      return;
    }
    const { remote_url, direction, credential, webhook_secret } = parsed.data;

    // Shown once in the response; the caller must persist it and configure
    // it as the GitHub webhook's secret — never retrievable from ADP again.
    const webhookSecret = webhook_secret ?? randomBytes(32).toString("hex");
    const credentialCiphertext = encryptCredential(credential, credentialKey);

    const mirror = await db.transaction(async (tx) => {
      let identityId: string | null = null;
      if (direction === "inbound" || direction === "both") {
        const [identity] = await tx
          .insert(identities)
          .values({ kind: "agent", principal: `mirror:github:${owner}/${name}` })
          .returning();
        identityId = identity!.id;
      }

      const [mirror] = await tx
        .insert(mirrors)
        .values({
          repoId: repo.id,
          direction,
          remoteUrl: remote_url,
          credentialCiphertext,
          webhookSecretCiphertext: encryptCredential(webhookSecret, credentialKey),
          identityId,
        })
        .returning();

      await recordOperation(tx, {
        repoId: repo.id,
        actorId: req.identity!.identityId,
        verb: "mirror.create",
        target: `${owner}/${name}`,
        after: { id: mirror!.id, remote_url, direction, credential: { configured: true } },
      });

      return mirror!;
    });

    reply.code(201).send({ ...serializeMirror(mirror), webhook_secret: webhookSecret });
  });

  app.get("/api/v3/repos/:owner/:repo/mirror", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: name } = req.params as { owner: string; repo: string };
    const repo = await findRepoAuthorized(db, req.identity!, owner, name);
    if (!repo) {
      reply.code(404).send({ message: "Not Found" });
      return;
    }
    const mirror = await findMirror(db, repo.id);
    if (!mirror) {
      reply.code(404).send({ message: "Not Found" });
      return;
    }

    const recentSyncLog = await db
      .select()
      .from(mirrorSyncLog)
      .where(eq(mirrorSyncLog.mirrorId, mirror.id))
      .orderBy(desc(mirrorSyncLog.createdAt))
      .limit(20);

    reply.send({
      ...serializeMirror(mirror),
      recent_sync_log: recentSyncLog.map((row) => ({
        id: row.id,
        direction: row.direction,
        ref: row.ref,
        sha: row.sha,
        status: row.status,
        attempts: row.attempts,
        last_error: row.lastError,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      })),
    });
  });

  app.delete("/api/v3/repos/:owner/:repo/mirror", { preHandler: requireScope("admin") }, async (req, reply) => {
    const { owner, repo: name } = req.params as { owner: string; repo: string };
    const repo = await findRepoAuthorized(db, req.identity!, owner, name);
    if (!repo) {
      reply.code(404).send({ message: "Not Found" });
      return;
    }
    const mirror = await findMirror(db, repo.id);
    if (!mirror) {
      reply.code(404).send({ message: "Not Found" });
      return;
    }

    await db.transaction(async (tx) => {
      await tx.delete(mirrorSyncLog).where(eq(mirrorSyncLog.mirrorId, mirror.id));
      await tx.delete(mirrors).where(eq(mirrors.id, mirror.id));

      await recordOperation(tx, {
        repoId: repo.id,
        actorId: req.identity!.identityId,
        verb: "mirror.delete",
        target: `${owner}/${name}`,
        before: { id: mirror.id, remote_url: mirror.remoteUrl, direction: mirror.direction },
      });
    });

    reply.code(204).send();
  });
}
