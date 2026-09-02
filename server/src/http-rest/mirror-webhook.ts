import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/client.js";
import type { GitBackend } from "../core/git-backend.js";
import type { Signer } from "../core/signing.js";
import { findRepo } from "../core/repos-lookup.js";
import { findMirror } from "../core/mirrors-lookup.js";
import { decryptCredential } from "../core/mirror-crypto.js";
import { dispatchGitHubEvent, type GitHubEventPayload } from "../core/github-event-dispatch.js";

// GitHub calls this route directly — it can't carry an ADP bearer token, so
// trust here is entirely the HMAC signature over the raw body (verified
// against the per-mirror webhookSecret), not req.identity.
function verifySignature(secret: string, rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const actual = signatureHeader.slice("sha256=".length);
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(actual, "hex");
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}

const WEBHOOK_PATH_PREFIX = "/webhooks/github/";

// Registers a content-type parser scoped (by URL prefix check, since
// Fastify's addContentTypeParser is otherwise global per content-type) to
// just this route: captures the raw body bytes GitHub's HMAC signature
// covers, instead of the app's normal JSON-parse-eagerly behavior, and
// falls through to ordinary JSON parsing for every other route.
export function registerMirrorWebhookRawBodyParser(app: FastifyInstance) {
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    if (req.url.startsWith(WEBHOOK_PATH_PREFIX)) {
      done(null, body);
      return;
    }
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8")));
    } catch (err) {
      done(err as Error, undefined);
    }
  });
}

export function registerMirrorWebhookRoutes(
  app: FastifyInstance,
  db: Db,
  gitBackend: GitBackend,
  signer: Signer,
  credentialKey: string,
  // Subject of the DSSE statement written for an ingested upstream run, same
  // role PUBLIC_URL plays for every other gate (http-rest/gates.ts).
  publicUrl: string,
  // Injectable so tests stand up a fake api.github.com for #233's check-run
  // writes, the same shape http-rest/actions.ts uses for the passthrough.
  fetchImpl: typeof fetch = fetch,
) {
  app.post("/webhooks/github/:owner/:name", async (req, reply) => {
    const { owner, name } = req.params as { owner: string; name: string };
    const rawBody = req.body as Buffer;

    const repo = await findRepo(db, owner, name);
    if (!repo) {
      reply.code(404).send({ message: "Not Found" });
      return;
    }
    const mirror = await findMirror(db, repo.id);
    if (!mirror || (mirror.direction !== "inbound" && mirror.direction !== "both")) {
      reply.code(404).send({ message: "Not Found" });
      return;
    }

    const webhookSecret = decryptCredential(mirror.webhookSecretCiphertext, credentialKey);
    if (!verifySignature(webhookSecret, rawBody, req.headers["x-hub-signature-256"] as string | undefined)) {
      reply.code(401).send({ message: "invalid signature" });
      return;
    }

    if (!mirror.enabled) {
      // 200, not a rejection: GitHub retries non-2xx responses, and a
      // deliberately-disabled mirror shouldn't trigger a retry storm.
      reply.send({ ok: true, skipped: "mirror disabled" });
      return;
    }

    let payload: GitHubEventPayload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      reply.code(400).send({ message: "malformed payload" });
      return;
    }

    // Dispatch on the event type GitHub declares, rather than inferring it from
    // the payload's shape. Before this, every delivery was assumed to be a push
    // and anything else was silently discarded as "not a branch push event" —
    // which is why upstream CI results never reached the evidence plane despite
    // the milestone depending on them.
    //
    // What that dispatch *does* lives in core/github-event-dispatch.ts, shared
    // with the GitHub App's single endpoint (#232). This route's own job is the
    // part that differs: which secret verifies the delivery, and which
    // repository it is for.
    const event = (req.headers["x-github-event"] as string | undefined) ?? "push";
    reply.send(
      await dispatchGitHubEvent({ db, gitBackend, signer, credentialKey, publicUrl, fetchImpl }, event, payload, repo, mirror),
    );
  });
}
