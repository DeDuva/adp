import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
import { Signer } from "../src/core/signing.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerIdentityRoutes } from "../src/http-rest/identity.js";
import { registerIssueRoutes } from "../src/http-rest/issues.js";
import { registerChangeRoutes } from "../src/http-rest/changes.js";

const execFileAsync = promisify(execFile);

// This is the M0 exit criterion from docs/pragmatic_mvp.md: "a real repo can
// be pushed to and cloned from the server over HTTPS with a token." Requires
// a real Postgres — set DATABASE_URL to run it locally, or rely on CI, which
// provides one as a service container. Silently skipped otherwise so `npm
// test` stays usable on a machine with no database.
describe.skipIf(!process.env.DATABASE_URL)("M0 end-to-end: token -> repo create -> clone -> push", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let workDir: string;
  let port: number;
  let token: string;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-git-"));
    const gitBackend = new GitBackend(gitRoot);

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body as Buffer),
    );
    await app.register(authPlugin(db));
    registerIdentityRoutes(app);
    registerRepoRoutes(app, db, gitBackend);
    registerIssueRoutes(app, db);
    registerChangeRoutes(app, db, gitBackend, new Signer("e2e-test-signing-key"));
    registerGitHttpRoutes(app, gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `e2e-test-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("rejects repo creation without a token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v3/repos/e2e-owner`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "hello" }),
    });
    expect(res.status).toBe(401);
  });

  it("creates a repo with a valid token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v3/repos/e2e-owner`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "hello" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { full_name: string };
    expect(body.full_name).toBe("e2e-owner/hello");
  });

  it("reports the authenticated user via GET /api/v3/user (gh auth status probe)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v3/user`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { login: string };
    expect(body.login).toContain("e2e-test-");
  });

  it("clones and pushes over HTTP using the token as the git password", async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-clone-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/e2e-owner/hello.git`;
    const cloneDir = path.join(workDir, "clone");

    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    // Cloning an empty repo names the local branch from the client's
    // init.defaultBranch, not the server's — pin it explicitly.
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo hi > README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "e2e commit"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });

    const { stdout } = await execFileAsync("git", ["log", "--oneline", "main"], {
      cwd: new GitBackend(gitRoot).repoPath("e2e-owner", "hello"),
    });
    expect(stdout).toContain("e2e commit");

    await rm(workDir, { recursive: true, force: true });
  });

  it("rejects a clone attempt with no credentials", async () => {
    await expect(
      execFileAsync("git", [
        "-c",
        "credential.helper=",
        "clone",
        `http://127.0.0.1:${port}/e2e-owner/hello.git`,
        path.join(await mkdtemp(path.join(tmpdir(), "adp-e2e-noauth-")), "clone"),
      ]),
    ).rejects.toThrow();
  });

  it("creates an issue, which files an intent, then a comment on it", async () => {
    const createRes = await fetch(`http://127.0.0.1:${port}/api/v3/repos/e2e-owner/hello/issues`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Add a README", body: "It's empty right now." }),
    });
    expect(createRes.status).toBe(201);
    const issue = (await createRes.json()) as { number: number; intent_id: string; state: string };
    expect(issue.state).toBe("open");
    expect(issue.intent_id).toBeTruthy();

    const commentRes = await fetch(
      `http://127.0.0.1:${port}/api/v3/repos/e2e-owner/hello/issues/${issue.number}/comments`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ body: "On it." }),
      },
    );
    expect(commentRes.status).toBe(201);

    const closeRes = await fetch(
      `http://127.0.0.1:${port}/api/v3/repos/e2e-owner/hello/issues/${issue.number}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state: "closed" }),
      },
    );
    expect(closeRes.status).toBe(200);
    const closed = (await closeRes.json()) as { state: string };
    expect(closed.state).toBe("closed");
  });

  it("records a signed change against a real commit, linked to an intent", async () => {
    const issueRes = await fetch(`http://127.0.0.1:${port}/api/v3/repos/e2e-owner/hello/issues`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Second task" }),
    });
    const issue = (await issueRes.json()) as { intent_id: string };

    const { stdout: sha } = await execFileAsync("git", ["rev-parse", "main"], {
      cwd: new GitBackend(gitRoot).repoPath("e2e-owner", "hello"),
    });

    const changeRes = await fetch(`http://127.0.0.1:${port}/api/v3/repos/e2e-owner/hello/changes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ git_sha: sha.trim(), intent_id: issue.intent_id }),
    });
    expect(changeRes.status).toBe(201);
    const change = (await changeRes.json()) as {
      id: string;
      git_sha: string;
      intent_id: string;
      signature: string;
      provenance: { kind: string; principal: string };
    };
    expect(change.git_sha).toBe(sha.trim());
    expect(change.intent_id).toBe(issue.intent_id);
    expect(change.provenance.kind).toBe("human");
    expect(change.signature).toBeTruthy();

    const getRes = await fetch(`http://127.0.0.1:${port}/api/v3/repos/e2e-owner/hello/changes/${change.id}`);
    expect(getRes.status).toBe(200);
  });

  it("rejects a change referencing a commit that doesn't exist", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v3/repos/e2e-owner/hello/changes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ git_sha: "f".repeat(40) }),
    });
    expect(res.status).toBe(422);
  });
});
