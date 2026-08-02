import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { identities, changes } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerHookRoutes } from "../src/http-git/hooks.js";
import { registerMirrorRoutes } from "../src/http-rest/mirrors.js";

const execFileAsync = promisify(execFile);

function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

// M2: mirror mode (docs/pragmatic_mvp.md) — bidirectional GitHub sync. A
// real second bare repo on local disk stands in for "GitHub" here: real git
// fetch/push, not fixtures, just not against a real github.com (which needs
// the deferred public HTTPS endpoint — see docs/environments-plan.md).
describe.skipIf(skipWithoutDb)("M2: mirror mode", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let githubStandInRoot: string;
  let port: number;
  let token: string;
  const owner = `mirror-owner-${Date.now()}`;

  async function initBareRepo(dir: string): Promise<void> {
    await execFileAsync("git", ["init", "--bare", "-b", "main", dir]);
  }

  async function pushCommit(bareRepoPath: string, message: string): Promise<string> {
    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-mirror-src-"));
    await execFileAsync("git", ["clone", bareRepoPath, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", `echo "${message}" >> README.md`], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", message], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    const sha = (await execFileAsync("git", ["rev-parse", "main"], { cwd: cloneDir })).stdout.trim();
    await rm(cloneDir, { recursive: true, force: true });
    return sha;
  }

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-mirror-git-"));
    githubStandInRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-mirror-github-"));
    const gitBackend = new GitBackend(gitRoot);
    const signer = new Signer("e2e-mirror-signing-key");

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend);
    registerHookRoutes(app, db, gitBackend, signer);
    registerMirrorRoutes(app, db, gitBackend, signer);
    registerGitHttpRoutes(app, gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;
    gitBackend.setInternalUrl(`http://127.0.0.1:${port}`);

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `mirror-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
    await rm(githubStandInRoot, { recursive: true, force: true });
  });

  it("inbound: a signed GitHub-shaped webhook fetches and records a first import", async () => {
    const repoName = "pull-mirror";
    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: repoName }),
    });

    const githubRepoPath = path.join(githubStandInRoot, `${repoName}.git`);
    await initBareRepo(githubRepoPath);
    const sha = await pushCommit(githubRepoPath, "first mirrored commit");

    const secret = "mirror-webhook-secret";
    const configureRes = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/mirror`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ remote_url: `file://${githubRepoPath}`, direction: "pull", webhook_secret: secret }),
    });
    expect(configureRes.status).toBe(201);
    const mirror = (await configureRes.json()) as { remote_url: string };
    expect(mirror.remote_url).toBe(`file://${githubRepoPath}`);

    const payload = JSON.stringify({ ref: "refs/heads/main", before: "0".repeat(40), after: sha });
    const webhookRes = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/mirror/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signBody(secret, payload) },
      body: payload,
    });
    expect(webhookRes.status).toBe(200);
    const result = (await webhookRes.json()) as { ok: boolean; sha: string };
    expect(result.ok).toBe(true);
    expect(result.sha).toBe(sha);

    const gitBackend = new GitBackend(gitRoot);
    expect(await gitBackend.resolveRef(owner, repoName, "main")).toBe(sha);

    const [change] = await db.select().from(changes).where(eq(changes.gitSha, sha));
    expect(change).toBeTruthy();
    expect((change!.provenance as { via: string }).via).toBe("mirror-ingest");
  });

  it("inbound webhook rejects a bad signature", async () => {
    const repoName = "pull-mirror-bad-sig";
    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: repoName }),
    });
    const githubRepoPath = path.join(githubStandInRoot, `${repoName}.git`);
    await initBareRepo(githubRepoPath);
    const sha = await pushCommit(githubRepoPath, "commit");

    const configureRes = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/mirror`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ remote_url: `file://${githubRepoPath}`, direction: "pull", webhook_secret: "the-real-secret" }),
    });
    expect(configureRes.status).toBe(201);

    const payload = JSON.stringify({ ref: "refs/heads/main", before: "0".repeat(40), after: sha });
    const webhookRes = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/mirror/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signBody("wrong-secret", payload) },
      body: payload,
    });
    expect(webhookRes.status).toBe(401);
  });

  it("outbound: a local push reaches the mirror target repo", async () => {
    const repoName = "push-mirror";
    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: repoName }),
    });

    const githubRepoPath = path.join(githubStandInRoot, `${repoName}-target.git`);
    await initBareRepo(githubRepoPath);

    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/mirror`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ remote_url: `file://${githubRepoPath}`, direction: "push", webhook_secret: "unused-for-push" }),
    });

    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-mirror-push-clone-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo hi > README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "pushed to be mirrored out"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    const sha = (await execFileAsync("git", ["rev-parse", "main"], { cwd: cloneDir })).stdout.trim();
    await rm(cloneDir, { recursive: true, force: true });

    // Fire-and-forget (core/mirror.ts's pushToMirror) — give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const { stdout } = await execFileAsync("git", ["rev-parse", "main"], { cwd: githubRepoPath });
    expect(stdout.trim()).toBe(sha);
  });
});
