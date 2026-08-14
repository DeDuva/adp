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
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerProposalRoutes } from "../src/http-rest/proposals.js";
import { registerGitDataRoutes } from "../src/http-rest/git-data.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { repoAccessCheck } from "../src/core/repos-lookup.js";
import { runMergeContention } from "../../bench/lib/merge-contention.mjs";

// M3-5, arm 1 (docs/m3-readiness-review.md): the merge-contention benchmark,
// enforced in CI at small N.
//
// This drives `bench/lib/merge-contention.mjs` — the exact code the published
// benchmark runs, not a reimplementation of it. A benchmark whose CI check
// exercises a different implementation from the one that produces the published
// numbers is checking nothing that matters.
//
// The assertions here are about *correctness under contention*, not about
// performance: no wall-clock thresholds, because a number that fails on a busy
// CI runner teaches a team to ignore it. What must hold on every machine is
// that every writer eventually lands, that nothing is lost, and that the
// conflict accounting adds up.
describe.skipIf(skipWithoutDb)("M3: merge-contention benchmark arm", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let gitBackend: GitBackend;
  let port: number;
  let token: string;
  const owner = `bench-owner-${Date.now()}`;
  const repoName = "widget";

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-bench-git-"));
    gitBackend = new GitBackend(gitRoot);

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerProposalRoutes(app, db, gitBackend, "e2e-bench-credential-key", []);
    registerGitDataRoutes(app, db, gitBackend);
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "agent", principal: `bench-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);

    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: repoName }),
    });

    // Seed main entirely through the git-database API — the same path the
    // driver uses, so the benchmark needs no clone and no git CLI.
    const api = async (method: string, p: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return (await res.json()) as Record<string, string>;
    };
    const tree = await api("POST", `/api/v3/repos/${owner}/${repoName}/git/trees`, {
      tree: [{ path: "README.md", mode: "100644", type: "blob", content: "seed\n" }],
    });
    const commit = await api("POST", `/api/v3/repos/${owner}/${repoName}/git/commits`, {
      message: "seed",
      tree: tree.sha,
      parents: [],
    });
    await api("POST", `/api/v3/repos/${owner}/${repoName}/git/refs`, {
      ref: "refs/heads/main",
      sha: commit.sha,
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("N concurrent writers all land on one branch, with contention accounted for", async () => {
    const WRITERS = 6;

    const result = await runMergeContention({
      baseUrl: `http://127.0.0.1:${port}`,
      token,
      owner,
      repo: repoName,
      writers: WRITERS,
    });

    // The correctness claim under contention: serial FF-guarded land means
    // N concurrent writers serialize, N−1 get a typed 409 and rebase, and
    // *everyone eventually lands*. Nothing is dropped and nothing deadlocks.
    expect(result.failures).toEqual([]);
    expect(result.landed).toBe(WRITERS);
    expect(result.failed).toBe(0);

    // Every writer attempted at least once, and each conflict cost exactly one
    // extra attempt — if these disagreed, the conflict rate would be measuring
    // something other than what it claims to.
    expect(result.totalAttempts).toBe(WRITERS + result.totalConflicts);
    expect(result.conflictRate).toBeCloseTo(result.totalConflicts / result.totalAttempts, 10);
    expect(result.retriesPerWriter.distribution).toHaveLength(WRITERS);

    // Conflict rate is a required output of this arm — A17 and the M5
    // speculative-batching gate both consume it specifically.
    expect(result.conflictRate).toBeGreaterThanOrEqual(0);
    expect(result.conflictRate).toBeLessThan(1);

    // Latency percentiles are ordered and populated. No threshold: a
    // wall-clock assertion that fails on a loaded CI runner teaches people to
    // ignore the check.
    expect(result.landLatencyMs.p50).toBeGreaterThan(0);
    expect(result.landLatencyMs.p95).toBeGreaterThanOrEqual(result.landLatencyMs.p50);
    expect(result.landLatencyMs.max).toBeGreaterThanOrEqual(result.landLatencyMs.p95);
    expect(result.landsPerSecond).toBeGreaterThan(0);

    // Every writer's file is on main: the real check that N serialized lands
    // composed rather than overwrote each other.
    for (let i = 0; i < WRITERS; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/contents/writer-${i}.txt`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
    }
  }, 300_000);
});
