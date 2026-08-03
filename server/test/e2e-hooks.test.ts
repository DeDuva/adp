import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type Db } from "../src/db/client.js";
import { changes, identities, operations } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { mintToken } from "../src/auth/tokens.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerHookRoutes } from "../src/http-git/hooks.js";
import { registerOperationRoutes } from "../src/http-rest/operations.js";
import { findRepo } from "../src/core/repos-lookup.js";

const execFileAsync = promisify(execFile);

// M1c: the receive-path hook subsystem (docs/pragmatic_mvp.md) — post-receive
// auto-records typed changes on push, pre-receive blocks a push containing a
// seeded secret with a typed, actionable error. Exercised through the real
// `git` binary end to end: these hooks only fire because GitBackend writes
// real hooks/pre-receive|post-receive scripts into the bare repo, invoked by
// `git receive-pack` itself during a real `git push`.
describe.skipIf(skipWithoutDb)("M1c: receive-path hooks", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  let identityId: string;
  let cleanRepoName: string;
  let cleanSha: string;
  const owner = `hooks-owner-${Date.now()}`;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-hooks-git-"));
    const gitBackend = new GitBackend(gitRoot);
    const signer = new Signer("e2e-hooks-signing-key");

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerHookRoutes(app, db, gitBackend, signer, "e2e-test-credential-key");
    registerOperationRoutes(app, db, gitBackend);
    registerGitHttpRoutes(app, gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;
    // Only known once listening — see GitBackend.setInternalUrl's comment.
    gitBackend.setInternalUrl(`http://127.0.0.1:${port}`);

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `hooks-e2e-${Date.now()}` })
      .returning();
    identityId = identity!.id;
    token = await mintToken(db, identityId, ["repo:read", "repo:write", "admin"]);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("post-receive auto-records a typed change for a clean push, no manual POST /changes needed", async () => {
    const repoName = "clean-repo";
    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: repoName }),
    });

    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-hooks-clean-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo hi > README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "clean commit"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });

    const sha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: cloneDir })).stdout.trim();
    cleanRepoName = repoName;
    cleanSha = sha;
    await rm(cloneDir, { recursive: true, force: true });

    // Give the post-receive hook's async fetch a moment — push returns as
    // soon as receive-pack's hooks finish, but post-receive fires after the
    // client's connection would already be closing.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const [change] = await db.select().from(changes).where(eq(changes.gitSha, sha));
    expect(change).toBeTruthy();
    expect(change!.signature).toBeTruthy();
    expect((change!.provenance as { via: string }).via).toBe("push");

    const [op] = await db.select().from(operations).where(eq(operations.target, `${owner}/${repoName}@${sha}`));
    expect(op).toBeTruthy();
    expect(op!.verb).toBe("change.create");
    expect(op!.actorId).toBe(identityId);
  });

  it("pre-receive rejects a push containing a seeded secret, with a typed error", async () => {
    const repoName = "secret-repo";
    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: repoName }),
    });

    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-hooks-secret-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo 'AWS_KEY=AKIAABCDEFGHIJKLMNOP' > secrets.env"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "oops committed a secret"], { cwd: cloneDir });

    let rejected = false;
    let stderr = "";
    try {
      await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    } catch (err) {
      rejected = true;
      stderr = (err as { stderr?: string }).stderr ?? String(err);
    }
    expect(rejected).toBe(true);
    expect(stderr).toMatch(/push protection/i);
    expect(stderr).toMatch(/aws-access-key-id/);

    // Confirm the ref genuinely never moved server-side, not just that the
    // client saw an error.
    const { stdout } = await execFileAsync("git", ["show-ref", "--heads"], {
      cwd: new GitBackend(gitRoot).repoPath(owner, repoName),
    }).catch(() => ({ stdout: "" }));
    expect(stdout).not.toContain("main");

    await rm(cloneDir, { recursive: true, force: true });
  });

  it("post-receive dedups: replaying the same ref update never double-records a change", async () => {
    const before = await db.select().from(changes).where(eq(changes.gitSha, cleanSha));
    expect(before).toHaveLength(1);

    const res = await fetch(`http://127.0.0.1:${port}/internal/hooks/post-receive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner,
        name: cleanRepoName,
        identityId,
        updates: [{ oldSha: "0".repeat(40), newSha: cleanSha, ref: "refs/heads/main" }],
      }),
    });
    expect(res.status).toBe(200);

    const after = await db.select().from(changes).where(eq(changes.gitSha, cleanSha));
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
  });

  it("history-query by path matches only operations whose commit touched that path", async () => {
    const hit = await fetch(
      `http://127.0.0.1:${port}/api/adp/repos/${owner}/${cleanRepoName}/operations?path=README.md`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(hit.status).toBe(200);
    const hitOps = (await hit.json()) as { target: string }[];
    expect(hitOps.some((op) => op.target === `${owner}/${cleanRepoName}@${cleanSha}`)).toBe(true);

    const miss = await fetch(
      `http://127.0.0.1:${port}/api/adp/repos/${owner}/${cleanRepoName}/operations?path=nonexistent.txt`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(miss.status).toBe(200);
    const missOps = (await miss.json()) as { target: string }[];
    expect(missOps.some((op) => op.target === `${owner}/${cleanRepoName}@${cleanSha}`)).toBe(false);
  });

  it(
    "post-receive chunks a >500-commit push instead of truncating it (docs/m2-readiness-review.md)",
    async () => {
      const repoName = "mirror-import";
      await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: repoName }),
      });

      const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-hooks-chunk-"));
      const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
      await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
      await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
      await execFileAsync("sh", ["-c", "echo hi > README.md"], { cwd: cloneDir });
      await execFileAsync("git", ["add", "."], { cwd: cloneDir });
      await execFileAsync("git", ["commit", "-m", "root"], { cwd: cloneDir });
      // A brand-new branch (push #1) takes a separate "record the tip only"
      // path (oldSha === ZERO_SHA, just above in hooks.ts) — pushing this
      // root commit first, then a follow-up push of >500 more, is what
      // exercises the `oldSha..newSha` chunking loop instead.
      await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });

      // One more than RECORD_BATCH_SIZE (500, http-git/hooks.ts) — a single
      // `git log --max-count=500` used to silently drop everything past the
      // newest 500 of these.
      const BULK_COMMIT_COUNT = 511;

      // Built with one `git fast-import` instead of 511 `git commit` spawns.
      // The loop version flaked in CI — "unable to read <sha>" while packing
      // for the push, i.e. an object that never finished being written — which
      // is what 511 rapid process spawns under container memory pressure looks
      // like. fast-import is one process writing one packfile, so the fixture
      // stops being a source of failures for a test that is about something
      // else entirely. The push it produces is identical.
      const rootSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: cloneDir })).stdout.trim();
      let stream = "";
      for (let i = 0; i < BULK_COMMIT_COUNT; i++) {
        const message = `bulk ${i}\n`;
        stream +=
          "commit refs/heads/main\n" +
          `mark :${i + 1}\n` +
          "committer Test <test@example.com> 1700000000 +0000\n" +
          `data ${Buffer.byteLength(message)}\n${message}` +
          `from ${i === 0 ? rootSha : `:${i}`}\n\n`;
      }
      stream += "done\n";
      const streamPath = path.join(cloneDir, "..", `fast-import-${Date.now()}.stream`);
      await writeFile(streamPath, stream);
      await execFileAsync("sh", ["-c", `git fast-import --done < ${JSON.stringify(streamPath)}`], { cwd: cloneDir });
      await rm(streamPath, { force: true });

      await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
      await rm(cloneDir, { recursive: true, force: true });

      // Two batches' worth of transactions to wait for, not one.
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const repo = await findRepo(db, owner, repoName);
      const recorded = await db.select().from(changes).where(eq(changes.repoId, repo!.id));
      expect(recorded).toHaveLength(BULK_COMMIT_COUNT + 1); // +1 for "root"
    },
    60_000,
  );

  it("rejects a call to the internal hook endpoints from anyone but loopback", async () => {
    // Fastify's supertest-less `inject()` lets us set a fake remote address,
    // which `fetch()` against the real listener can't do from this process
    // (it's always actually loopback) — this is the one assertion in this
    // suite that needs to simulate a non-local caller.
    const res = await app.inject({
      method: "POST",
      url: "/internal/hooks/post-receive",
      remoteAddress: "203.0.113.5",
      payload: { owner, name: cleanRepoName, identityId, updates: [] },
    });
    expect(res.statusCode).toBe(403);
  });
});
