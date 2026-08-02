import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
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
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerProposalRoutes } from "../src/http-rest/proposals.js";
import { registerGitDataRoutes } from "../src/http-rest/git-data.js";

const execFileAsync = promisify(execFile);

// M1b′ item 2: the Tier-2 REST tail (docs/pragmatic_mvp.md) — contents,
// commits/compare, git/refs|blobs|trees|commits, PR files/diff, and the
// GitHub-standard repo-create paths. All backed by the real `git` binary.
describe.skipIf(skipWithoutDb)("M1b′ REST: Tier-2 tail", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  let baseSha: string;
  let featureSha: string;
  const owner = `tail-owner-${Date.now()}`;

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

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-tail-git-"));
    const gitBackend = new GitBackend(gitRoot);

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend);
    registerProposalRoutes(app, db, gitBackend, "e2e-test-credential-key");
    registerGitDataRoutes(app, db, gitBackend);
    registerGitHttpRoutes(app, gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `tail-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);

    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "widget" }),
    });

    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-tail-clone-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/widget.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "mkdir dir && echo hi > README.md && echo nested > dir/file.txt"], {
      cwd: cloneDir,
    });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    baseSha = (await execFileAsync("git", ["rev-parse", "main"], { cwd: cloneDir })).stdout.trim();

    await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo more >> README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-am", "feature commit"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "feature"], { cwd: cloneDir });
    featureSha = (await execFileAsync("git", ["rev-parse", "feature"], { cwd: cloneDir })).stdout.trim();

    await rm(cloneDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("POST /user/repos and POST /orgs/:org/repos create repos at GitHub-standard paths", async () => {
    const userRepo = await api("/api/v3/user/repos", { method: "POST", body: JSON.stringify({ name: "mine" }) });
    expect(userRepo.status).toBe(201);

    const org = `${owner}-org`;
    const orgRepo = await api(`/api/v3/orgs/${org}/repos`, {
      method: "POST",
      body: JSON.stringify({ name: "theirs" }),
    });
    expect(orgRepo.status).toBe(201);
    expect((orgRepo.body as { full_name: string }).full_name).toBe(`${org}/theirs`);
  });

  it("GET contents lists a directory and reads a file's base64 content", async () => {
    const root = await api(`/api/v3/repos/${owner}/widget/contents/`);
    expect(root.status).toBe(200);
    const names = (root.body as { name: string }[]).map((e) => e.name).sort();
    expect(names).toEqual(["README.md", "dir"]);

    const file = await api(`/api/v3/repos/${owner}/widget/contents/README.md`);
    expect(file.status).toBe(200);
    const decoded = Buffer.from((file.body as { content: string }).content, "base64").toString("utf8");
    expect(decoded).toBe("hi\n");

    const nested = await api(`/api/v3/repos/${owner}/widget/contents/dir`);
    expect((nested.body as { name: string; path: string }[])[0]!.path).toBe("dir/file.txt");
  });

  it("GET commits lists history and GET commits/:sha fetches one", async () => {
    const list = await api(`/api/v3/repos/${owner}/widget/commits?sha=feature`);
    expect(list.status).toBe(200);
    expect((list.body as unknown[]).length).toBe(2);

    const single = await api(`/api/v3/repos/${owner}/widget/commits/${baseSha}`);
    expect(single.status).toBe(200);
    expect((single.body as { sha: string }).sha).toBe(baseSha);
  });

  it("GET compare/base...head reports ahead/behind and changed files", async () => {
    const { status, body } = await api(`/api/v3/repos/${owner}/widget/compare/main...feature`);
    expect(status).toBe(200);
    const b = body as { status: string; ahead_by: number; behind_by: number; files: { filename: string }[] };
    expect(b.status).toBe("ahead");
    expect(b.ahead_by).toBe(1);
    expect(b.behind_by).toBe(0);
    expect(b.files.map((f) => f.filename)).toEqual(["README.md"]);
  });

  it("git/refs: lists, creates, and deletes a ref", async () => {
    const list = await api(`/api/v3/repos/${owner}/widget/git/refs/heads`);
    expect(list.status).toBe(200);
    expect((list.body as { ref: string }[]).some((r) => r.ref === "refs/heads/main")).toBe(true);

    const created = await api(`/api/v3/repos/${owner}/widget/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: "refs/heads/scratch", sha: baseSha }),
    });
    expect(created.status).toBe(201);

    const del = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/widget/git/refs/heads/scratch`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(del.status).toBe(204);
  });

  it("git/blobs, git/trees, git/commits round-trip a new commit built from scratch", async () => {
    const blob = await api(`/api/v3/repos/${owner}/widget/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: "brand new file\n", encoding: "utf-8" }),
    });
    expect(blob.status).toBe(201);
    const blobSha = (blob.body as { sha: string }).sha;

    const blobGet = await api(`/api/v3/repos/${owner}/widget/git/blobs/${blobSha}`);
    expect(Buffer.from((blobGet.body as { content: string }).content, "base64").toString("utf8")).toBe(
      "brand new file\n",
    );

    const tree = await api(`/api/v3/repos/${owner}/widget/git/trees`, {
      method: "POST",
      body: JSON.stringify({
        tree: [{ path: "scratch.txt", mode: "100644", type: "blob", sha: blobSha }],
      }),
    });
    expect(tree.status).toBe(201);
    const treeSha = (tree.body as { sha: string }).sha;

    const commit = await api(`/api/v3/repos/${owner}/widget/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message: "scratch commit", tree: treeSha, parents: [baseSha] }),
    });
    expect(commit.status).toBe(201);
    const commitSha = (commit.body as { sha: string }).sha;

    const commitGet = await api(`/api/v3/repos/${owner}/widget/git/commits/${commitSha}`);
    expect(commitGet.status).toBe(200);
    expect((commitGet.body as { message: string }).message).toBe("scratch commit");

    const treeGet = await api(`/api/v3/repos/${owner}/widget/git/trees/${treeSha}`);
    expect((treeGet.body as { tree: { path: string }[] }).tree.map((e) => e.path)).toEqual(["scratch.txt"]);
  });

  it("PR files lists changed files, and Accept: diff returns a unified diff", async () => {
    const createRes = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/widget/pulls`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Add more", head: "feature", base: "main" }),
    });
    const pr = (await createRes.json()) as { number: number };

    const files = await api(`/api/v3/repos/${owner}/widget/pulls/${pr.number}/files`);
    expect(files.status).toBe(200);
    expect((files.body as { filename: string }[]).map((f) => f.filename)).toEqual(["README.md"]);

    const diffRes = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/widget/pulls/${pr.number}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.diff" },
    });
    expect(diffRes.status).toBe(200);
    const diffText = await diffRes.text();
    expect(diffText).toContain("README.md");
    void featureSha;
  });
});
