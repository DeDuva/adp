import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { identities, orgs, repos } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerWorkspaceRoutes } from "../src/http-rest/workspaces.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";

const execFileAsync = promisify(execFile);

// M4-3 (docs/m4-readiness-review.md §4): org-scoped quotas, proven through
// the real REST routes rather than by calling the underlying functions
// directly — a quota that's correct in the function but never reached by the
// route that's supposed to enforce it protects nothing.
describe.skipIf(skipWithoutDb)("M4-3: org quotas", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let gitBackend: GitBackend;
  let port: number;
  let token: string;

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

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-quotas-git-"));
    gitBackend = new GitBackend(gitRoot);

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerWorkspaceRoutes(app, db, gitBackend);
    registerGitHttpRoutes(app, gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [identity] = await db.insert(identities).values({ kind: "human", principal: `quotas-e2e-${Date.now()}` }).returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("assigns every new repo to a found-or-created org named after its owner", async () => {
    const owner = `quota-org-assign-${Date.now()}`;
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: "a" }) });
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: "b" }) });

    const [orgRow] = await db.select().from(orgs).where(eq(orgs.name, owner));
    expect(orgRow).toBeDefined();

    const repoRows = await db.select().from(repos).where(eq(repos.owner, owner));
    expect(repoRows).toHaveLength(2);
    expect(repoRows.every((r) => r.orgId === orgRow!.id)).toBe(true);
  });

  it("refuses to create a repo past the org's maxRepos, with a 403 naming the limit", async () => {
    const owner = `quota-repos-${Date.now()}`;
    // Seed the org with its cap before the first repo, same as an operator
    // would set it — findOrCreateOrg (http-rest/repos.ts) then finds this
    // row instead of creating a fresh unlimited one.
    await db.insert(orgs).values({ name: owner, maxRepos: 1 });

    const first = await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: "one" }) });
    expect(first.status).toBe(201);

    const second = await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: "two" }) });
    expect(second.status).toBe(403);
    expect((second.body as { message: string }).message).toMatch(/quota exceeded \(max 1\)/);

    const repoRows = await db.select().from(repos).where(eq(repos.owner, owner));
    expect(repoRows).toHaveLength(1); // the refused create left no partial row
  });

  it("refuses to create a workspace past the org's maxConcurrentWorkspaces, counted across every repo in the org", async () => {
    const owner = `quota-workspaces-${Date.now()}`;
    await db.insert(orgs).values({ name: owner, maxConcurrentWorkspaces: 1 });

    // Two repos in the same org — the quota is org-wide, so the second
    // workspace has to be refused even though it's a *different* repo.
    for (const name of ["repo-a", "repo-b"]) {
      await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name }) });
      const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-quotas-clone-"));
      await execFileAsync("git", ["clone", `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${name}.git`, cloneDir]);
      await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
      await execFileAsync("sh", ["-c", "echo hi > f.txt"], { cwd: cloneDir });
      await execFileAsync("git", ["add", "."], { cwd: cloneDir });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd: cloneDir });
      await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
      await rm(cloneDir, { recursive: true, force: true });
    }

    const first = await api(`/api/adp/repos/${owner}/repo-a/workspaces`, {
      method: "POST",
      body: JSON.stringify({ base_ref: "main" }),
    });
    expect(first.status).toBe(201);

    const second = await api(`/api/adp/repos/${owner}/repo-b/workspaces`, {
      method: "POST",
      body: JSON.stringify({ base_ref: "main" }),
    });
    expect(second.status).toBe(422);
    expect((second.body as { message: string }).message).toMatch(/quota exceeded \(max 1\)/);
  });
});
