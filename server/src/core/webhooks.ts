import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { webhooks } from "../db/schema.js";
import { decryptCredential } from "./mirror-crypto.js";

export type WebhookEventType = "push" | "pull_request" | "gate_result";

export interface WebhookLogger {
  warn(msg: string): void;
  error(msg: string): void;
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

// GitHub's own header shape (`X-Hub-Signature-256: sha256=<hex hmac>`) —
// matching it costs nothing and means an adopter's existing webhook receiver
// (built against GitHub) verifies ADP's deliveries without changes.
export function signPayload(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function deliverOnce(targetUrl: string, secret: string, eventType: WebhookEventType, body: string): Promise<void> {
  const res = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-ADP-Event": eventType,
      "X-Hub-Signature-256": signPayload(secret, body),
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`responded ${res.status}`);
  }
}

// Retries with backoff, then gives up — logged, not queued. A persistent
// retry queue (dead-letter storage, redelivery UI) is real infrastructure
// this M2 slice doesn't need yet; three attempts covers a target that's
// blipping, not one that's gone for good.
async function deliverWithRetry(
  targetUrl: string,
  secret: string,
  eventType: WebhookEventType,
  body: string,
  logger: WebhookLogger,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await deliverOnce(targetUrl, secret, eventType, body);
      return;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (attempt === MAX_ATTEMPTS) {
        logger.error(`webhook delivery to ${targetUrl} (${eventType}) gave up after ${MAX_ATTEMPTS} attempts: ${reason}`);
        return;
      }
      logger.warn(`webhook delivery to ${targetUrl} (${eventType}) failed, attempt ${attempt}/${MAX_ATTEMPTS}: ${reason}`);
      await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS * 2 ** (attempt - 1)));
    }
  }
}

// Fire-and-forget by design: an event source (a push, a merge, a gate
// report) must never block its own response on a third party's endpoint
// being slow or down. Callers invoke this without awaiting it.
export function emitWebhookEvent(
  db: Db,
  repoId: string,
  eventType: WebhookEventType,
  payload: unknown,
  logger: WebhookLogger,
  credentialKey: string,
): void {
  const body = JSON.stringify(payload);
  db.select()
    .from(webhooks)
    .where(and(eq(webhooks.repoId, repoId), eq(webhooks.active, true)))
    .then((hooks) => {
      for (const hook of hooks) {
        if (!hook.events.includes(eventType)) continue;
        const secret = decryptCredential(hook.secretCiphertext, credentialKey);
        void deliverWithRetry(hook.targetUrl, secret, eventType, body, logger);
      }
    })
    .catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(`webhook lookup for repo ${repoId} failed: ${reason}`);
    });
}
