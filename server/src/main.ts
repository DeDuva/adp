import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { loadConfig } from "./config.js";
import { createHash } from "node:crypto";
import { createDb } from "./db/client.js";
import { GitBackend } from "./core/git-backend.js";
import { KeyRegistry, Signer } from "./core/signing.js";
import { authPlugin } from "./auth/plugin.js";
import { registerMirrorWebhookRawBodyParser } from "./http-rest/mirror-webhook.js";
import { registerApiRoutes } from "./routes.js";
import { startMirrorPoller } from "./core/mirror-poller.js";
import { startInboundPoller } from "./core/mirror-inbound-poller.js";
import { startWorkspaceSweeper } from "./core/workspace-sweeper.js";
import { startRetentionSweeper } from "./core/trajectory-retention.js";
import { startGateJobReaper } from "./core/gate-job-reaper.js";
import { findOrCreateSystemIdentity } from "./core/system-identity.js";
import { LandRequirement } from "./core/repo-policy.js";
import { recordHttpRequest, renderMetrics } from "./core/telemetry.js";
import { startGateJobMetricsSampler } from "./core/gate-job-metrics.js";
import { startStorageMeter } from "./core/storage-usage.js";
import { registerVersionRoute, resolveBuildInfo } from "./core/version.js";

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
  // operator's scraper, not a repo-scoped resource (the
  // "API-traffic telemetry" item).
  app.get("/metrics", async (_req, reply) => {
    reply.type("text/plain; version=0.0.4").send(renderMetrics());
  });
  // Same unauthenticated set, same reason: "what is deployed here?" is an
  // operator's question about the process, not a repo-scoped resource. Read
  // once at boot — the deployed container has no checkout to consult per
  // request, and re-reading one would answer for the wrong tree anyway.
  registerVersionRoute(app, resolveBuildInfo(), new Date());

  // The full route table lives in routes.ts so the spec-coverage test can
  // enumerate exactly what this process serves (server/src/spec-coverage.test.ts).
  registerApiRoutes(app, {
    db,
    gitBackend,
    signer,
    keyRegistry: new KeyRegistry(signer, (config.RETIRED_SIGNING_PUBLIC_KEYS ?? "").split(",")),
    publicUrl: config.PUBLIC_URL,
    credentialKey: config.MIRROR_CREDENTIAL_KEY,
    instanceFloor,
    retentionDays: config.TRAJECTORY_RETENTION_DAYS,
    gitMaxPackBytes: config.GIT_MAX_PACK_BYTES,
    // M4-5. Both credentials or nothing: half-configured OIDC would mount
    // routes that cannot complete a flow, which is worse than not having them.
    oidc:
      config.OIDC_CLIENT_ID && config.OIDC_CLIENT_SECRET
        ? {
            issuer: config.OIDC_ISSUER,
            discoveryUrl: config.OIDC_DISCOVERY_URL,
            clientId: config.OIDC_CLIENT_ID,
            clientSecret: config.OIDC_CLIENT_SECRET,
            allowedDomains: config.OIDC_ALLOWED_DOMAINS,
            tokenTtlMinutes: config.OIDC_TOKEN_TTL_MINUTES,
            publicUrl: config.PUBLIC_URL,
            // Domain-separated from the Ed25519 evidence key derived from the
            // same env var (core/signing.ts): one secret, two independent
            // keys, and no way for a login cookie to be mistaken for — or to
            // help forge — a signature over evidence.
            cookieKey: createHash("sha256")
              .update(`adp-oidc-flow-cookie:${config.SIGNING_KEY}`)
              .digest(),
          }
        : undefined,
  });

  // The read-only supervision UI ("web/ served
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

  // #228: inbound without a public hostname. Runs alongside the webhook rather
  // than instead of it — every ingest either drives is idempotent, because
  // GitHub redelivers, so an instance that has both configured records each
  // fact once and it does not matter which arrived first.
  if (config.MIRROR_INBOUND_POLL_INTERVAL_MS > 0) {
    startInboundPoller(
      {
        db,
        gitBackend,
        signer,
        credentialKey: config.MIRROR_CREDENTIAL_KEY,
        publicUrl: config.PUBLIC_URL,
      },
      config.MIRROR_INBOUND_POLL_INTERVAL_MS,
    );
  }

  const sweeperActorId = await findOrCreateSystemIdentity(db, "system:workspace-sweeper");
  startWorkspaceSweeper(db, gitBackend, sweeperActorId, config.WORKSPACE_SWEEP_INTERVAL_MS);

  // #92: requeues (or, past the retry cap, errors) running gate jobs whose
  // lease expired — the recovery path for a runner that died mid-job.
  const reaperActorId = await findOrCreateSystemIdentity(db, "system:gate-job-reaper");
  startGateJobReaper(db, reaperActorId, config.GATE_JOB_REAPER_INTERVAL_MS);

  // M4-11: keeps the gate-job queue gauges on /metrics current. No actor
  // identity and no recordOperation — unlike the sweeper this changes
  // nothing, it only reads.
  startGateJobMetricsSampler(db, config.GATE_JOB_METRICS_INTERVAL_MS);

  // M4-3: the storage meter every org's byte ceiling is enforced against,
  // and the source of the adp_storage_bytes gauge. Like the sampler it takes
  // no actor identity — it writes only its own reading back onto the org row
  // and records no operation, because a measurement is not a change to the
  // thing measured.
  startStorageMeter(db, gitBackend, config.STORAGE_METER_INTERVAL_MS);

  // #161: the interim retention window. Unlike the meter above this *changes*
  // what ADP holds, so it takes an actor identity and records an operation per
  // sweep — reducing what the record holds is itself a change to the record,
  // and this project says such things in the log rather than in a metric.
  const retentionActorId = await findOrCreateSystemIdentity(db, "system:trajectory-retention");
  startRetentionSweeper(
    db,
    config.TRAJECTORY_RETENTION_DAYS,
    retentionActorId,
    config.TRAJECTORY_RETENTION_INTERVAL_MS,
  );
  if (config.TRAJECTORY_RETENTION_DAYS === 0) {
    app.log.warn("TRAJECTORY_RETENTION_DAYS=0 — trajectory payloads are kept forever on this instance");
  } else {
    app.log.info(
      `trajectory payloads are reduced after ${config.TRAJECTORY_RETENTION_DAYS} days ` +
        "(chain, hashes and typed columns are kept); override per org",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
