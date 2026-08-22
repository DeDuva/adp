import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, count, eq, isNull } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { identities, orgs, repos, workspaces, gateJobs } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { repoAccessCheck } from "../src/core/repos-lookup.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerWorkspaceRoutes } from "../src/http-rest/workspaces.js";
import { registerGateJobRoutes } from "../src/http-rest/gate-jobs.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";

const execFileAsync = promisify(execFile);

// #94 (docs/m4-postmortem-audit.md §P1-3): every quota is now evaluated
// inside the transaction that consumes it, serialized on the org row —
// before this, all three counts ran outside the mutating transaction, so
// two concurrent requests both read count = cap - 1, both passed, and every
// "hard ceiling" was advisory precisely when it was being contended. All
// three pre-existing quota tests were sequential, so none of them could
// see it. These are the concurrent ones.
describe.skipIf(skipWithoutDb)("#94: quotas hold under concurrency", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  let identityId: string;

  async function api(pathAndQuery: string, init: RequestInit = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-quota-race-git-"));
    const gitBackend = new GitBackend(gitRoot);
    const signer = new Signer("e2e-quota-race-signing-key");

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerWorkspaceRoutes(app, db, gitBackend);
    registerGateJobRoutes(app, db, gitBackend, signer, "https://adp.example.com", "e2e-test-credential-key");
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `quota-race-${Date.now()}` })
      .returning();
    identityId = identity!.id;
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("maxRepos = 1: eight concurrent creates admit exactly one", async () => {
    const owner = `qr-repos-${Date.now()}`;
    const orgId = await grantOwner(db, identityId, owner);
    await db.update(orgs).set({ maxRepos: 1 }).where(eq(orgs.id, orgId));

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: `r${i}` }) }),
      ),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 403)).toHaveLength(7);

    const [row] = await db.select({ n: count() }).from(repos).where(eq(repos.orgId, orgId));
    expect(row!.n).toBe(1);
  });

  it("maxConcurrentWorkspaces = 1: eight concurrent creates admit exactly one", async () => {
    const owner = `qr-ws-${Date.now()}`;
    const orgId = await grantOwner(db, identityId, owner);
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: "repo" }) });

    // A workspace branches from a real commit; an empty repo has none.
    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-quota-race-clone-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/repo.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo hi > f.txt"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    await rm(cloneDir, { recursive: true, force: true });

    // The cap goes on AFTER the repo exists so repo-create itself is not
    // what's being throttled here.
    await db.update(orgs).set({ maxConcurrentWorkspaces: 1 }).where(eq(orgs.id, orgId));

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        api(`/api/adp/repos/${owner}/repo/workspaces`, { method: "POST", body: JSON.stringify({ base_ref: "main" }) }),
      ),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 422)).toHaveLength(7);

    const [live] = await db
      .select({ n: count() })
      .from(workspaces)
      .innerJoin(repos, eq(workspaces.repoId, repos.id))
      .where(and(eq(repos.orgId, orgId), isNull(workspaces.destroyedAt)));
    expect(live!.n).toBe(1);
  });

  it("maxConcurrentGateJobs = 1: a burst of concurrent claims never runs two of the org's jobs at once", async () => {
    const owner = `qr-gj-${Date.now()}`;
    const orgId = await grantOwner(db, identityId, owner);
    await db.update(orgs).set({ maxConcurrentGateJobs: 1 }).where(eq(orgs.id, orgId));
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: "repo" }) });

    const [runner] = await db.insert(identities).values({ kind: "agent", principal: `qr-runner-${Date.now()}` }).returning();
    const runnerToken = await mintToken(db, runner!.id, ["runner"]);

    for (let i = 0; i < 4; i++) {
      const res = await api(`/api/adp/repos/${owner}/repo/gate-jobs`, {
        method: "POST",
        body: JSON.stringify({ git_sha: "d".repeat(40), name: `cap-${i}`, image: "busybox:1", command: "true" }),
      });
      expect(res.status).toBe(201);
    }

    // Fire claims in bursts. Whoever claims (this runner, or any other
    // file's polling — the cap binds every claimant identically), the
    // invariant is that the org never has two jobs running. Sample it after
    // every burst: under the old separate-read check, a single concurrent
    // burst at count = 0 routinely admitted two.
    for (let round = 0; round < 5; round++) {
      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          fetch(`http://127.0.0.1:${port}/api/adp/gate-jobs/claim`, {
            method: "POST",
            headers: { Authorization: `Bearer ${runnerToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ claimed_by: `qr-burst-${round}-${i}` }),
          }),
        ),
      );
      const [running] = await db
        .select({ n: count() })
        .from(gateJobs)
        .innerJoin(repos, eq(gateJobs.repoId, repos.id))
        .where(and(eq(repos.orgId, orgId), eq(gateJobs.status, "running")));
      expect(running!.n).toBeLessThanOrEqual(1);
    }
  });
});
