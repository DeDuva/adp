import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/client.js";
import type { GitBackend } from "../core/git-backend.js";
import type { Signer } from "../core/signing.js";
import { identities, mirrors, mirrorSyncLog } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { findRepo } from "../core/repos-lookup.js";
import { findMirror } from "../core/mirrors-lookup.js";
import { recordPushedCommits } from "../core/change-recorder.js";
import { decryptCredential, redactUrl } from "../core/mirror-crypto.js";
import { ingestWorkflowRun, resolveMirrorReporter, type WorkflowRunPayload } from "../core/actions-ingest.js";
import { ingestPullRequest, type PullRequestPayload } from "../core/pull-request-ingest.js";

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

    let payload: { ref?: string; after?: string } & WorkflowRunPayload & PullRequestPayload;
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
    const event = (req.headers["x-github-event"] as string | undefined) ?? "push";

    if (event === "workflow_run") {
      const reporterId = await resolveMirrorReporter(db, mirror.identityId);
      if (!reporterId) {
        // Outbound-only mirrors have no system identity, and gate_results
        // .reporterId is a hard FK — nothing safe to attribute this to.
        reply.send({ ok: true, skipped: "mirror has no ingest identity" });
        return;
      }
      const result = await ingestWorkflowRun(db, signer, publicUrl, repo, reporterId, payload);
      reply.send({ ok: true, ...(result.recorded ? { recorded: result.gateName } : { skipped: result.reason }) });
      return;
    }

    // A pull request is the object the rest of companion mode hangs off:
    // policy evaluation, undo and the evidence bundle all take a proposal, and
    // until this there was none for the work a companion-mode developer
    // actually does. Handled beside workflow_run rather than in the push
    // branch because the two are independent — a pull request exists before
    // any of its commits reach this instance, and its commits reach here
    // whether or not it is ever opened.
    if (event === "pull_request") {
      const actorId = await resolveMirrorReporter(db, mirror.identityId);
      if (!actorId) {
        // Same hard-FK problem workflow_run has: proposals.authorId and
        // operations.actorId both reference identities, and an outbound-only
        // mirror has no system identity to attribute an ingested row to.
        reply.send({ ok: true, skipped: "mirror has no ingest identity" });
        return;
      }
      const result = await ingestPullRequest(db, gitBackend, repo, mirror.id, actorId, payload);
      reply.send({
        ok: true,
        ...(result.recorded
          ? { recorded: `proposal#${result.number}`, change: result.change }
          : { skipped: result.reason }),
        ...(result.merge ? { merge: result.merge } : {}),
      });
      return;
    }

    if (event !== "push") {
      reply.send({ ok: true, skipped: `unhandled event '${event}'` });
      return;
    }

    if (!payload.ref || !payload.after) {
      reply.send({ ok: true, skipped: "not a branch push event" });
      return;
    }

    const remoteRef = payload.ref; // e.g. refs/heads/main
    const branch = remoteRef.replace(/^refs\/heads\//, "");
    if (remoteRef === branch) {
      // Not a branch ref (e.g. a tag) — v0 only mirrors branches.
      reply.send({ ok: true, skipped: "not a branch ref" });
      return;
    }

    const currentSha = await gitBackend.resolveRef(owner, name, branch);

    try {
      // credential isn't needed to fetch a public repo, but mirrors are
      // configured against the same PAT used for outbound pushes — reuse
      // it here too so private GitHub repos work identically.
      const url = new URL(mirror.remoteUrl);
      url.username = "x-access-token";
      url.password = decryptCredential(mirror.credentialCiphertext, credentialKey);

      const fetchedSha = await gitBackend.fetchFromRemote(owner, name, url.toString(), remoteRef);

      const isFastForward = currentSha === null || (await gitBackend.isAncestor(owner, name, currentSha, fetchedSha));
      if (!isFastForward) {
        await db.insert(mirrorSyncLog).values({
          mirrorId: mirror.id,
          direction: "inbound",
          ref: remoteRef,
          sha: fetchedSha,
          status: "failed",
          lastError: `diverged: refs/heads/${branch} is not an ancestor of the fetched commit`,
        });
        reply.send({ ok: false, reason: "diverged" });
        return;
      }

      let moved: boolean;
      if (currentSha) {
        moved = await gitBackend.fastForwardRef(owner, name, branch, currentSha, fetchedSha);
      } else {
        await gitBackend.createRef(owner, name, `refs/heads/${branch}`, fetchedSha);
        moved = true;
      }
      if (!moved) {
        await db.insert(mirrorSyncLog).values({
          mirrorId: mirror.id,
          direction: "inbound",
          ref: remoteRef,
          sha: fetchedSha,
          status: "failed",
          lastError: "ref moved concurrently, retry",
        });
        reply.send({ ok: false, reason: "concurrent-update" });
        return;
      }

      const [identity] = mirror.identityId ? await db.select().from(identities).where(eq(identities.id, mirror.identityId)) : [];
      if (identity) {
        await recordPushedCommits(
          db,
          gitBackend,
          signer,
          owner,
          name,
          repo.id,
          { id: identity.id, kind: identity.kind, principal: identity.principal },
          currentSha ?? "0".repeat(40),
          fetchedSha,
          "mirror-inbound",
        );
      }

      await db.insert(mirrorSyncLog).values({
        mirrorId: mirror.id,
        direction: "inbound",
        ref: remoteRef,
        sha: fetchedSha,
        status: "success",
      });
      await db.update(mirrors).set({ lastInboundSha: fetchedSha, updatedAt: new Date() }).where(eq(mirrors.id, mirror.id));

      reply.send({ ok: true });
    } catch (err) {
      await db.insert(mirrorSyncLog).values({
        mirrorId: mirror.id,
        direction: "inbound",
        ref: remoteRef,
        sha: payload.after,
        status: "failed",
        lastError: redactUrl(err instanceof Error ? err.message : String(err)),
      });
      reply.send({ ok: false, reason: "error" });
    }
  });
}
