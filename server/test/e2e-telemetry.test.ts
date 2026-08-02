import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type Db } from "../src/db/client.js";
import { identities } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { loadGitHubSchema } from "../src/http-gql/schema.js";
import { attachResolvers } from "../src/http-gql/attach-resolvers.js";
import { createResolvers } from "../src/http-gql/resolvers.js";
import { registerGraphQLRoute } from "../src/http-gql/route.js";
import { recordHttpRequest, renderMetrics, resetMetricsForTest } from "../src/core/telemetry.js";

// M2: API-traffic telemetry (docs/m2-readiness-review.md's "measurement gap"
// item) — this is the wiring test (main.ts's onResponse hook + /metrics
// route + GraphQL root-field counting) to go with core/telemetry.test.ts's
// unit coverage of the counter/render logic itself.
describe.skipIf(skipWithoutDb)("M2: API-traffic telemetry", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  const owner = `telemetry-owner-${Date.now()}`;

  beforeAll(async () => {
    resetMetricsForTest();

    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-telemetry-git-"));
    const gitBackend = new GitBackend(gitRoot);

    app = Fastify({ logger: false });
    await app.register(authPlugin(db));

    // Mirrors main.ts's wiring, not a reimplementation of it — same hook,
    // same route.
    app.addHook("onResponse", async (req, reply) => {
      const route = req.routeOptions.url ?? "(unmatched)";
      recordHttpRequest(req.method, route, reply.statusCode);
    });
    app.get("/metrics", async (_req, reply) => {
      reply.type("text/plain; version=0.0.4").send(renderMetrics());
    });

    registerRepoRoutes(app, db, gitBackend);
    const schema = loadGitHubSchema();
    attachResolvers(schema, createResolvers(gitBackend, "e2e-test-credential-key"));
    registerGraphQLRoute(app, schema, db);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `telemetry-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("/metrics reflects a real REST request by route pattern and status", async () => {
    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "widget" }),
    });

    const metricsRes = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(metricsRes.status).toBe(200);
    const body = await metricsRes.text();
    expect(body).toContain('adp_http_requests_total{method="POST",route="/api/v3/repos/:owner",status="201"}');
  });

  it("/metrics reflects a real GraphQL query by root field and outcome", async () => {
    await fetch(`http://127.0.0.1:${port}/api/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query { repository(owner: "${owner}", name: "widget") { name } }`,
      }),
    });

    const metricsRes = await fetch(`http://127.0.0.1:${port}/metrics`);
    const body = await metricsRes.text();
    expect(body).toContain(
      'adp_graphql_operations_total{operation_type="query",field="repository",outcome="ok"}',
    );
  });
});
