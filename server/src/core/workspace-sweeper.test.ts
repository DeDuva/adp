import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../db/client.js";
import { identities, repos, workspaces } from "../db/schema.js";
import { GitBackend } from "./git-backend.js";
import { sweepExpiredWorkspaces } from "./workspace-sweeper.js";

const execFileAsync = promisify(execFile);

// M4-3: the scheduled sweep that generalizes M3-2's on-demand candidate-set
// reclamation, against real Postgres + a real bare repo — same rigor
// mirror-poller.test.ts holds the mirror outbox poller to.
describe.skipIf(!process.env.DATABASE_URL)("sweepExpiredWorkspaces", () => {
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let gitBackend: GitBackend;
  let repoId: string;
  let owner: string;
  let actorId: string;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-sweeper-git-"));
    gitBackend = new GitBackend(gitRoot);

    owner = `sweeper-owner-${Date.now()}`;
    await gitBackend.initBareRepo(owner, "repo", "main");

    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-sweeper-clone-"));
    const repoUrl = gitBackend.repoPath(owner, "repo");
    await execFileAsync("git", ["clone", repoUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo hi > f.txt"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    await rm(cloneDir, { recursive: true, force: true });

    const [identity] = await db.insert(identities).values({ kind: "human", principal: `sweeper-${Date.now()}` }).returning();
    actorId = identity!.id;
    const [repo] = await db.insert(repos).values({ owner, name: "repo", defaultBranch: "main" }).returning();
    repoId = repo!.id;
  });

  afterAll(async () => {
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  async function makeWorkspace(opts: { expiresAt: Date | null; destroyedAt?: Date }) {
    const branch = `adp/ws/${Math.random().toString(36).slice(2)}`;
    const baseSha = await gitBackend.resolveRef(owner, "repo", "main");
    await gitBackend.createRef(owner, "repo", `refs/heads/${branch}`, baseSha!);
    const [workspace] = await db
      .insert(workspaces)
      .values({
        repoId,
        branch,
        baseRef: "main",
        baseSha: baseSha!,
        createdById: actorId,
        expiresAt: opts.expiresAt,
        destroyedAt: opts.destroyedAt,
      })
      .returning();
    return workspace!;
  }

  it("destroys a workspace past its expiry, deleting the real ref and setting destroyedAt", async () => {
    const expired = await makeWorkspace({ expiresAt: new Date(Date.now() - 60_000) });

    const result = await sweepExpiredWorkspaces(db, gitBackend, actorId);
    expect(result.swept).toBeGreaterThanOrEqual(1);

    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, expired.id));
    expect(row!.destroyedAt).not.toBeNull();
    expect(await gitBackend.resolveRef(owner, "repo", expired.branch)).toBeNull();
  });

  it("leaves a workspace with no expiry alone", async () => {
    const neverExpires = await makeWorkspace({ expiresAt: null });

    await sweepExpiredWorkspaces(db, gitBackend, actorId);

    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, neverExpires.id));
    expect(row!.destroyedAt).toBeNull();
    expect(await gitBackend.resolveRef(owner, "repo", neverExpires.branch)).not.toBeNull();
  });

  it("leaves a workspace not yet expired alone", async () => {
    const notYet = await makeWorkspace({ expiresAt: new Date(Date.now() + 3600_000) });

    await sweepExpiredWorkspaces(db, gitBackend, actorId);

    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, notYet.id));
    expect(row!.destroyedAt).toBeNull();
  });

  it("skips a workspace that is expired but already destroyed, without erroring", async () => {
    const alreadyGone = await makeWorkspace({ expiresAt: new Date(Date.now() - 60_000), destroyedAt: new Date() });

    const result = await sweepExpiredWorkspaces(db, gitBackend, actorId);
    expect(result).toBeDefined();

    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, alreadyGone.id));
    expect(row!.destroyedAt).not.toBeNull();
  });
});
