import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "../core/git-backend.js";
import type { Signer } from "../core/signing.js";
import { mirrors } from "../db/schema.js";
import { requireScope } from "../auth/plugin.js";
import { findRepo } from "../core/repos-lookup.js";
import { findMirror, ingestMirrorPush, verifyGithubSignature, type GithubPushPayload } from "../core/mirror.js";

const ConfigureMirrorBody = z.object({
  remote_url: z.string().url(),
  direction: z.enum(["push", "pull", "both"]).default("both"),
  webhook_secret: z.string().min(1),
});

// Redacts the credentials git itself expects embedded in the URL
// (`https://x-access-token:<token>@github.com/...`) — same reasoning as
// webhooks.ts never echoing a hook's secret back.
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function serializeMirror(mirror: typeof mirrors.$inferSelect) {
  return {
    id: mirror.id,
    remote_url: redactUrl(mirror.remoteUrl),
    direction: mirror.direction,
    active: mirror.active,
    created_at: mirror.createdAt.toISOString(),
  };
}

// Mirror mode (docs/pragmatic_mvp.md M2): a repo stays on GitHub and gets an
// ADP workspace alongside it. This file is the config surface (one mirror
// per repo) plus the inbound webhook GitHub calls; the outbound push leg is
// wired at http-git/hooks.ts's post-receive (core/mirror.ts's pushToMirror).
export function registerMirrorRoutes(app: FastifyInstance, db: Db, gitBackend: GitBackend, signer: Signer) {
  app.post("/api/v3/repos/:owner/:repo/mirror", { preHandler: requireScope("repo:write") }, async (req, reply) => {
    const { owner, repo: repoName } = req.params as { owner: string; repo: string };
    const parsed = ConfigureMirrorBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
      return;
    }
    const repo = await findRepo(db, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }

    const existing = await findMirror(db, repo.id);
    if (existing) {
      reply.code(422).send({ message: "a mirror is already configured for this repository" });
      return;
    }

    const [mirror] = await db
      .insert(mirrors)
      .values({
        repoId: repo.id,
        remoteUrl: parsed.data.remote_url,
        direction: parsed.data.direction,
        webhookSecret: parsed.data.webhook_secret,
        configuredById: req.identity!.identityId,
      })
      .returning();

    reply.code(201).send(serializeMirror(mirror!));
  });

  app.get("/api/v3/repos/:owner/:repo/mirror", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: repoName } = req.params as { owner: string; repo: string };
    const repo = await findRepo(db, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }
    const mirror = await findMirror(db, repo.id);
    if (!mirror) {
      reply.code(404).send({ message: "Not Found" });
      return;
    }
    reply.send(serializeMirror(mirror));
  });

  app.delete("/api/v3/repos/:owner/:repo/mirror", { preHandler: requireScope("repo:write") }, async (req, reply) => {
    const { owner, repo: repoName } = req.params as { owner: string; repo: string };
    const repo = await findRepo(db, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }
    const deleted = await db.delete(mirrors).where(eq(mirrors.repoId, repo.id)).returning();
    if (deleted.length === 0) {
      reply.code(404).send({ message: "Not Found" });
      return;
    }
    reply.code(204).send();
  });

  // No bearer-token auth: GitHub's own webhook caller never carries one —
  // authenticity comes entirely from the HMAC signature, verified against
  // this repo's configured mirror secret, same trust model as GitHub's own
  // webhook receivers expect from *their* subscribers.
  //
  // Registered in its own encapsulated scope so only this route gets a raw
  // (unparsed) body — HMAC verification needs the exact bytes GitHub signed,
  // not a re-serialization of the parsed JSON, which could differ in key
  // order or whitespace and silently break every signature.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
      done(null, body);
    });

    scope.post("/api/v3/repos/:owner/:repo/mirror/webhook", async (req, reply) => {
      const { owner, repo: repoName } = req.params as { owner: string; repo: string };
      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }
      const mirror = await findMirror(db, repo.id);
      if (!mirror) {
        reply.code(404).send({ message: "no mirror configured for this repository" });
        return;
      }

      const rawBody = req.body as string;
      const signatureHeader = req.headers["x-hub-signature-256"] as string | undefined;
      if (!verifyGithubSignature(mirror.webhookSecret, rawBody, signatureHeader)) {
        reply.code(401).send({ message: "invalid signature" });
        return;
      }

      const payload = JSON.parse(rawBody) as Partial<GithubPushPayload>;
      if (!payload.ref || !payload.before || !payload.after) {
        reply.code(400).send({ message: "malformed push payload: ref, before, and after are required" });
        return;
      }

      const result = await ingestMirrorPush(db, gitBackend, signer, repo, mirror, {
        ref: payload.ref,
        before: payload.before,
        after: payload.after,
      });
      if (!result.ok) {
        reply.code(result.status).send({ message: result.message });
        return;
      }
      reply.send({ ok: true, ref: result.recordedRef, sha: result.sha });
    });
  });
}
