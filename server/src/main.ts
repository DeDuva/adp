import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { GitBackend } from "./core/git-backend.js";
import { Signer } from "./core/signing.js";
import { authPlugin } from "./auth/plugin.js";
import { registerMirrorWebhookRawBodyParser } from "./http-rest/mirror-webhook.js";
import { registerApiRoutes } from "./routes.js";
import { startMirrorPoller } from "./core/mirror-poller.js";
import { LandRequirement } from "./core/repo-policy.js";
import { recordHttpRequest, renderMetrics } from "./core/telemetry.js";

async function main() {
  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL);
  // Loopback, not PUBLIC_URL — the receive-path hooks (http-git/hooks.ts)
  // are spawned locally by `git receive-pack` on this same host and call
  // straight back to this process; there's no reason to route that through
  // the public hostname/TLS.
  const internalUrl = `http://127.0.0.1:${config.PORT}`;
  const gitBackend = new GitBackend(config.GIT_ROOT, internalUrl);
  const signer = new Signer(config.SIGNING_KEY);
  // Fails fast at boot if misconfigured, matching config.ts's philosophy —
  // LAND_POLICY_FLOOR is a plain string list there so config.ts doesn't
  // need to depend on core/repo-policy.ts's enum.
  const instanceFloor = LandRequirement.array().parse(config.LAND_POLICY_FLOOR);

  // Deliberately NOT ignoreTrailingSlash. It is the tidy-looking fix for `gh
  // auth status` probing `GET /api/v3/` (see http-rest/identity.ts) and it
  // does fix that — but it also breaks @fastify/static's directory-index
  // route: with the flag on, `/ui/` 404s while `/ui/index.html` still serves,
  // which takes the whole supervision UI offline. Buying one path's tolerance
  // with a global routing change is a bad trade; identity.ts registers both
  // spellings itself instead.
  const app = Fastify({ logger: true });

  // git smart-HTTP payloads (pack data) must reach the CGI subprocess
  // untouched and unbuffered — no `parseAs`, so `payload` is the raw request
  // stream itself; http-git/proxy.ts pipes it straight into `git
  // http-backend`'s stdin instead of materializing it as a Buffer first.
  app.addContentTypeParser(
    ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
    (_req, payload, done) => done(null, payload),
  );
  // Must be registered before authPlugin: it replaces the default
  // application/json parser app-wide, scoped internally to only affect
  // /webhooks/github/* (see its own comment) — GitHub's webhook signature
  // covers the raw body bytes, which the default eager-JSON-parse discards.
  registerMirrorWebhookRawBodyParser(app);

  await app.register(authPlugin(db));

  // Route pattern (":owner/:repo", not the literal path) keeps cardinality
  // bounded regardless of how many repos exist — a 404 has no matched route,
  // so it's bucketed under one fixed label instead of one per garbage path
  // an attacker or a typo could throw at the server.
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url ?? "(unmatched)";
    recordHttpRequest(req.method, route, reply.statusCode);
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => {
    await pool.query("SELECT 1");
    return { status: "ok" };
  });
  // Prometheus text format, unauthenticated like /healthz and /readyz — an
  // operator's scraper, not a repo-scoped resource (docs/m2-readiness-review.md's
  // "API-traffic telemetry" item).
  app.get("/metrics", async (_req, reply) => {
    reply.type("text/plain; version=0.0.4").send(renderMetrics());
  });

  // The full route table lives in routes.ts so the spec-coverage test can
  // enumerate exactly what this process serves (server/src/spec-coverage.test.ts).
  registerApiRoutes(app, {
    db,
    gitBackend,
    signer,
    publicUrl: config.PUBLIC_URL,
    credentialKey: config.MIRROR_CREDENTIAL_KEY,
    instanceFloor,
    gitMaxPackBytes: config.GIT_MAX_PACK_BYTES,
  });

  // The read-only supervision UI (docs/pragmatic_mvp.md §4.6: "web/ served
  // as static assets"), at /ui/* rather than / — the git routes already own
  // /:owner/:repo.git/*, and this avoids any ambiguity with them. It's a
  // single-page app with no client-side URL routing (App.tsx navigates via
  // in-memory state), so unlike a typical SPA there's no history-fallback
  // to wire up: only /ui/, /ui/index.html, and /ui/assets/* are ever
  // requested. Skipped with a log line if `cd web && npm run build` hasn't
  // been run yet, so a fresh checkout's plain `npm run dev` still boots.
  const webDist = path.join(path.dirname(fileURLToPath(import.meta.url)), "../web/dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/ui/" });
  } else {
    app.log.warn(`web UI not built (${webDist} missing) — skipping /ui/*; run "cd web && npm run build"`);
  }

  await app.listen({ host: "0.0.0.0", port: config.PORT });

  startMirrorPoller(db, gitBackend, config.MIRROR_CREDENTIAL_KEY, config.MIRROR_POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
