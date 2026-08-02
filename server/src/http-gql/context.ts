import type { Db } from "../db/client.js";
import type { AuthenticatedIdentity } from "../auth/tokens.js";
import type { WebhookLogger } from "../core/webhooks.js";

export interface GqlContext {
  db: Db;
  identity: AuthenticatedIdentity | null;
  // The request's own logger (Fastify's req.log) — resolvers that fire
  // webhooks (core/webhooks.ts) need somewhere to log delivery failures.
  log: WebhookLogger;
}
