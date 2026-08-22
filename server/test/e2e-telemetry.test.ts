import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { identities, repos, gateJobs } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { loadGitHubSchema } from "../src/http-gql/schema.js";
import { attachResolvers } from "../src/http-gql/attach-resolvers.js";
import { createResolvers } from "../src/http-gql/resolvers.js";
import { registerGraphQLRoute } from "../src/http-gql/route.js";
import { recordHttpRequest, renderMetrics, resetMetricsForTest } from "../src/core/telemetry.js";
import { sampleGateJobMetrics } from "../src/core/gate-job-metrics.js";

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
  let actorId: string;
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

    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
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
    actorId = identity!.id;
    token = await mintToken(db, actorId, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, actorId, owner);
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

  // M4-11: the gate-job queue gauges, sampled against real Postgres rather
  // than a stubbed count — the query (a GROUP BY with an epoch extract) is
  // the part that can be wrong, and it cannot be wrong in a mock.
  //
  // `gate_jobs` is instance-wide and shared with every other e2e file vitest
  // runs concurrently against this database (the lesson M4-9d's tests
  // learned the hard way), so nothing here asserts an exact queue depth.
  // The backdated job below makes the interesting assertion concurrency-proof
  // in the right direction: "oldest" is a max over ages, so another test's
  // queued job can only push the sampled age up, never below this one's.
  it("samples gate-job queue depth and oldest-queued age from real rows", async () => {
    const [repo] = await db.select().from(repos).where(eq(repos.owner, owner));
    expect(repo).toBeDefined();

    const backdated = new Date(Date.now() - 600_000);
    const [job] = await db
      .insert(gateJobs)
      .values({
        repoId: repo!.id,
        gitSha: "b".repeat(40),
        name: "queue-gauge",
        image: "busybox:1",
        command: "true",
        timeoutMs: 60_000,
        actorId,
        createdAt: backdated,
      })
      .returning();

    try {
      const sample = await sampleGateJobMetrics(db);

      // Zero-fill, not omission: both non-terminal states are always present.
      expect([...sample.byStatus.keys()].sort()).toEqual(["queued", "running"]);
      expect(sample.byStatus.get("queued")).toBeGreaterThanOrEqual(1);
      expect(sample.oldestQueuedAgeSeconds).toBeGreaterThanOrEqual(600);

      const metricsRes = await fetch(`http://127.0.0.1:${port}/metrics`);
      const body = await metricsRes.text();
      expect(body).toMatch(/^adp_gate_jobs\{status="queued"\} \d+$/m);
      expect(body).toMatch(/^adp_gate_job_oldest_queued_age_seconds \d+$/m);
      expect(body).toMatch(/^adp_gate_job_oldest_running_age_seconds \d+$/m);

      // #92: the running-age gauge exists and sees a running job. The gauge
      // is a table-wide max over a database every e2e file shares, so the
      // only bound this test may assert is the one its own row guarantees —
      // at least the 300s this job has "been running". (That it anchors on
      // started_at rather than created_at is pinned by the SQL's CASE per
      // status; a tighter upper-bound assertion here would really be
      // asserting that no other test file has a running job, which is not
      // this test's to promise.)
      await db
        .update(gateJobs)
        .set({ status: "running", startedAt: new Date(Date.now() - 300_000) })
        .where(eq(gateJobs.id, job!.id));
      const runningSample = await sampleGateJobMetrics(db);
      expect(runningSample.oldestRunningAgeSeconds).toBeGreaterThanOrEqual(300);
    } finally {
      await db.delete(gateJobs).where(eq(gateJobs.id, job!.id));
    }
  });
});
