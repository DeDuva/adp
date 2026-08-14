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
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { repoAccessCheck } from "../src/core/repos-lookup.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerProposalRoutes } from "../src/http-rest/proposals.js";
import { registerOperationRoutes } from "../src/http-rest/operations.js";

const execFileAsync = promisify(execFile);

// M1c: the op log read API + undo (docs/pragmatic_mvp.md Tier 4 — native
// plane, "no GitHub analogue"). No land-policy floor here (empty instance
// floor) — this suite is about the op log and undo mechanics, not policy,
// which is already covered by e2e-gates.test.ts.
describe.skipIf(skipWithoutDb)("M1c: operations log + undo", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let gitBackend: GitBackend;
  let port: number;
  let token: string;
  const owner = `ops-owner-${Date.now()}`;

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

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-ops-git-"));
    gitBackend = new GitBackend(gitRoot);

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerProposalRoutes(app, db, gitBackend, "e2e-test-credential-key", []); // no land-policy floor in this suite
    registerOperationRoutes(app, db, gitBackend);
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `ops-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("lists the op log for a repo and undoes a merge, reverting the ref and reopening the PR", async () => {
    const repoName = "widget";
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: repoName }) });

    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-ops-clone-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo hi > README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    const baseSha = (await execFileAsync("git", ["rev-parse", "main"], { cwd: cloneDir })).stdout.trim();

    await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo more >> README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "feature commit"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "feature"], { cwd: cloneDir });
    const headSha = (await execFileAsync("git", ["rev-parse", "feature"], { cwd: cloneDir })).stdout.trim();
    await rm(cloneDir, { recursive: true, force: true });

    const createRes = await api(`/api/v3/repos/${owner}/${repoName}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: "Add more", head: "feature", base: "main" }),
    });
    const pr = createRes.body as { number: number };

    const mergeRes = await api(`/api/v3/repos/${owner}/${repoName}/pulls/${pr.number}/merge`, {
      method: "PUT",
      body: "{}",
    });
    expect(mergeRes.status).toBe(200);
    // merge_method defaults to "merge" — main lands on a new merge commit
    // whose history still reaches the feature head, not headSha reused verbatim.
    const mergedSha = (mergeRes.body as { sha: string }).sha;
    expect(mergedSha).not.toBe(headSha);
    expect(await gitBackend.resolveRef(owner, repoName, "main")).toBe(mergedSha);
    await execFileAsync("git", ["merge-base", "--is-ancestor", headSha, mergedSha], {
      cwd: gitBackend.repoPath(owner, repoName),
    });

    const list = await api(`/api/adp/repos/${owner}/${repoName}/operations?verb=proposal.merge`);
    expect(list.status).toBe(200);
    const mergeOps = list.body as { id: string; verb: string; target: string }[];
    expect(mergeOps).toHaveLength(1);
    expect(mergeOps[0]!.target).toBe(`${owner}/${repoName}#${pr.number}`);

    const single = await api(`/api/adp/repos/${owner}/${repoName}/operations/${mergeOps[0]!.id}`);
    expect(single.status).toBe(200);

    const undoRes = await api(`/api/adp/repos/${owner}/${repoName}/operations/${mergeOps[0]!.id}/undo`, {
      method: "POST",
      body: "{}",
    });
    expect(undoRes.status).toBe(200);
    expect((undoRes.body as { verb: string; parent_op: string }).verb).toBe("proposal.merge.undo");
    expect((undoRes.body as { parent_op: string }).parent_op).toBe(mergeOps[0]!.id);

    expect(await gitBackend.resolveRef(owner, repoName, "main")).toBe(baseSha);

    const prAfterUndo = await api(`/api/v3/repos/${owner}/${repoName}/pulls/${pr.number}`);
    expect((prAfterUndo.body as { state: string }).state).toBe("open");

    // A second undo of the same operation is refused, not a silent no-op.
    const secondUndo = await api(`/api/adp/repos/${owner}/${repoName}/operations/${mergeOps[0]!.id}/undo`, {
      method: "POST",
      body: "{}",
    });
    expect(secondUndo.status).toBe(422);
  });

  it("refuses to undo a merge once the branch has moved since (would silently drop later work)", async () => {
    const repoName = "widget2";
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: repoName }) });

    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-ops-clone2-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo hi > README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });

    await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo more >> README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "feature commit"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "feature"], { cwd: cloneDir });

    const createRes = await api(`/api/v3/repos/${owner}/${repoName}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: "Add more", head: "feature", base: "main" }),
    });
    const pr = createRes.body as { number: number };
    await api(`/api/v3/repos/${owner}/${repoName}/pulls/${pr.number}/merge`, { method: "PUT", body: "{}" });

    // Something else lands on main after the merge.
    await execFileAsync("git", ["checkout", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["pull", "origin", "main"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo yet-more >> README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-am", "later commit"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    const laterSha = (await execFileAsync("git", ["rev-parse", "main"], { cwd: cloneDir })).stdout.trim();
    await rm(cloneDir, { recursive: true, force: true });

    const list = await api(`/api/adp/repos/${owner}/${repoName}/operations?verb=proposal.merge`);
    const mergeOp = (list.body as { id: string }[])[0]!;

    const undoRes = await api(`/api/adp/repos/${owner}/${repoName}/operations/${mergeOp.id}/undo`, {
      method: "POST",
      body: "{}",
    });
    expect(undoRes.status).toBe(422);
    expect((undoRes.body as { message: string }).message).toMatch(/moved since/i);
    expect(await gitBackend.resolveRef(owner, repoName, "main")).toBe(laterSha);
  });
});
