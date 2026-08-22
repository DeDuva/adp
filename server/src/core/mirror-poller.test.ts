import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../db/client.js";
import { skipWithoutDb } from "../../test/require-db.js";
import { identities, mirrors, mirrorSyncLog, repos } from "../db/schema.js";
import { GitBackend } from "./git-backend.js";
import { encryptCredential } from "./mirror-crypto.js";
import { findOrCreateOrg } from "./org-lookup.js";
import { pollOnce } from "./mirror-poller.js";

const execFileAsync = promisify(execFile);
const CREDENTIAL_KEY = "test-mirror-credential-key";

// M2 mirror mode's outbox poller: drains mirror_sync_log rows against real
// Postgres + two real local bare repos (the second stands in for GitHub —
// see git-backend.test.ts's mirror describe block for why file:// is fine).
describe.skipIf(skipWithoutDb)("mirror-poller", () => {
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let mirrorRoot: string;
  let gitBackend: GitBackend;
  let mirrorBackend: GitBackend;
  let repoId: string;
  let mirrorId: string;
  let baseSha: string;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-poller-adp-"));
    mirrorRoot = await mkdtemp(path.join(tmpdir(), "adp-poller-github-"));
    gitBackend = new GitBackend(gitRoot);
    mirrorBackend = new GitBackend(mirrorRoot);

    const owner = `poller-owner-${Date.now()}`;
    await gitBackend.initBareRepo(owner, "repo", "main");
    await mirrorBackend.initBareRepo("github-owner", "repo", "main");

    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-poller-clone-"));
    const repoUrl = gitBackend.repoPath(owner, "repo");
    await execFileAsync("git", ["clone", repoUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo hi > f.txt"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    baseSha = (await execFileAsync("git", ["rev-parse", "main"], { cwd: cloneDir })).stdout.trim();
    await rm(cloneDir, { recursive: true, force: true });

    const [identity] = await db.insert(identities).values({ kind: "human", principal: `poller-${Date.now()}` }).returning();
    const orgId = await findOrCreateOrg(db, owner);
    const [repo] = await db.insert(repos).values({ owner, name: "repo", defaultBranch: "main", orgId }).returning();
    repoId = repo!.id;
    void identity;

    const [mirror] = await db
      .insert(mirrors)
      .values({
        repoId,
        direction: "outbound",
        remoteUrl: `file://${mirrorBackend.repoPath("github-owner", "repo")}`,
        credentialCiphertext: encryptCredential("unused-for-file-remote", CREDENTIAL_KEY),
        webhookSecretCiphertext: encryptCredential("unused", CREDENTIAL_KEY),
      })
      .returning();
    mirrorId = mirror!.id;
  });

  afterAll(async () => {
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
    await rm(mirrorRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.delete(mirrorSyncLog).where(eq(mirrorSyncLog.mirrorId, mirrorId));
  });

  it("pushes a pending row to the remote and marks it success", async () => {
    await db.insert(mirrorSyncLog).values({
      mirrorId,
      direction: "outbound",
      ref: "refs/heads/main",
      sha: baseSha,
      status: "pending",
    });

    await pollOnce(db, gitBackend, CREDENTIAL_KEY);

    const [row] = await db.select().from(mirrorSyncLog).where(eq(mirrorSyncLog.mirrorId, mirrorId));
    expect(row!.status).toBe("success");
    expect(await mirrorBackend.resolveRef("github-owner", "repo", "main")).toBe(baseSha);

    const [mirror] = await db.select().from(mirrors).where(eq(mirrors.id, mirrorId));
    expect(mirror!.lastOutboundSha).toBe(baseSha);
  });

  it("marks a row failed with a redacted error when the push fails, without moving the remote ref", async () => {
    await db.insert(mirrorSyncLog).values({
      mirrorId,
      direction: "outbound",
      ref: "refs/heads/main",
      sha: "0".repeat(40).replace(/0$/, "1"), // a sha that doesn't exist locally -> push fails
      status: "pending",
    });

    await pollOnce(db, gitBackend, CREDENTIAL_KEY);

    const [row] = await db.select().from(mirrorSyncLog).where(eq(mirrorSyncLog.mirrorId, mirrorId));
    expect(row!.status).toBe("failed");
    expect(row!.attempts).toBe(1);
    expect(row!.lastError).toBeTruthy();
    expect(row!.lastError).not.toContain("unused-for-file-remote");
  });
});
