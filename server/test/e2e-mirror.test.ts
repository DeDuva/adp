import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq, and } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { changes, identities, mirrors, mirrorSyncLog, operations } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { pollOnce } from "../src/core/mirror-poller.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerHookRoutes } from "../src/http-git/hooks.js";
import { registerMirrorRoutes } from "../src/http-rest/mirrors.js";
import { registerMirrorWebhookRoutes, registerMirrorWebhookRawBodyParser } from "../src/http-rest/mirror-webhook.js";

const execFileAsync = promisify(execFile);
const CREDENTIAL_KEY = "e2e-mirror-credential-key";

// M2: mirror mode end to end. `githubStandIn` is a second plain bare repo
// (no ADP hooks) playing the role of the real GitHub remote — connected via
// file:// paths, no live network. Covers outbound (a real `git push` into
// ADP gets pushed out by the poller), inbound (a webhook, HMAC-signed like
// GitHub's, triggers a fetch back into ADP with auto-record), divergence
// (neither side force-moves a ref it can't fast-forward), and a bad
// signature (rejected before any DB write).
describe.skipIf(!process.env.DATABASE_URL)("M2: mirror mode", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let mirrorRoot: string;
  let gitBackend: GitBackend;
  let githubStandIn: GitBackend;
  let port: number;
  let token: string;
  const owner = `mirror-owner-${Date.now()}`;
  const repoName = "mirrored-repo";

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-mirror-git-"));
    mirrorRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-mirror-github-"));
    gitBackend = new GitBackend(gitRoot);
    githubStandIn = new GitBackend(mirrorRoot);
    await githubStandIn.initBareRepo(owner, repoName, "main");

    const signer = new Signer("e2e-mirror-signing-key");

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    registerMirrorWebhookRawBodyParser(app);
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerHookRoutes(app, db, gitBackend, signer, CREDENTIAL_KEY);
    registerMirrorRoutes(app, db, CREDENTIAL_KEY);
    registerMirrorWebhookRoutes(app, db, gitBackend, signer, CREDENTIAL_KEY, "https://adp.example.com");
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

    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: repoName }),
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
    await rm(mirrorRoot, { recursive: true, force: true });
  });

  async function createMirror(direction: "outbound" | "inbound" | "both") {
    const res = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/mirror`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        remote_url: `file://${githubStandIn.repoPath(owner, repoName)}`,
        direction,
        credential: "unused-for-file-remote",
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; webhook_secret: string };
  }

  // mirrors.repo_id is unique, so a mirror left over from a prior test whose
  // assertions failed before reaching its own DELETE call would otherwise
  // make every later createMirror() in this suite fail with 422 — a single
  // real assertion failure cascading into unrelated ones. Runs after every
  // test regardless of outcome, not just at the end of a passing test body.
  afterEach(async () => {
    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/mirror`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  it("outbound: a real push into ADP is pushed out to the mirror by the poller", async () => {
    await createMirror("outbound");

    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-mirror-clone-out-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo one > f.txt"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "outbound commit"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    const sha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: cloneDir })).stdout.trim();
    await rm(cloneDir, { recursive: true, force: true });

    await new Promise((resolve) => setTimeout(resolve, 500)); // let post-receive's outbox insert land
    await pollOnce(db, gitBackend, CREDENTIAL_KEY);

    expect(await githubStandIn.resolveRef(owner, repoName, "main")).toBe(sha);

    const getRes = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/mirror`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await getRes.json()) as { last_outbound_sha: string; recent_sync_log: { status: string }[] };
    expect(body.last_outbound_sha).toBe(sha);
    expect(body.recent_sync_log.some((r) => r.status === "success")).toBe(true);
  });

  it("inbound: a push straight to the mirror, ingested via a signed webhook, auto-records a change", async () => {
    const { id: mirrorId, webhook_secret } = await createMirror("inbound");

    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-mirror-clone-in-"));
    await execFileAsync("git", ["clone", githubStandIn.repoPath(owner, repoName), cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo two > g.txt"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "inbound commit"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    const sha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: cloneDir })).stdout.trim();
    await rm(cloneDir, { recursive: true, force: true });

    const payload = JSON.stringify({ ref: "refs/heads/main", after: sha });
    const signature = "sha256=" + createHmac("sha256", webhook_secret).update(payload).digest("hex");

    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github/${owner}/${repoName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

    expect(await gitBackend.resolveRef(owner, repoName, "main")).toBe(sha);

    const [change] = await db.select().from(changes).where(eq(changes.gitSha, sha));
    expect(change).toBeTruthy();
    expect((change!.provenance as { via: string }).via).toBe("mirror-inbound");

    const [op] = await db.select().from(operations).where(eq(operations.target, `${owner}/${repoName}@${sha}`));
    expect(op).toBeTruthy();

    const [mirror] = await db.select().from(mirrors).where(eq(mirrors.id, mirrorId));
    expect(mirror!.lastInboundSha).toBe(sha);
  });

  it("rejects a webhook call with a bad signature, writing nothing", async () => {
    const { webhook_secret } = await createMirror("inbound");
    void webhook_secret;

    const before = await db.select().from(mirrorSyncLog);

    const payload = JSON.stringify({ ref: "refs/heads/main", after: "f".repeat(40) });
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github/${owner}/${repoName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=" + "0".repeat(64) },
      body: payload,
    });
    expect(res.status).toBe(401);

    const after = await db.select().from(mirrorSyncLog);
    expect(after.length).toBe(before.length);
  });

  it("diverged histories: neither direction force-moves a ref, both surface as failed", async () => {
    const { webhook_secret } = await createMirror("both");

    // Diverge: push a commit through ADP...
    const adpClone = await mkdtemp(path.join(tmpdir(), "adp-e2e-mirror-div-adp-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, adpClone]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: adpClone });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: adpClone });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: adpClone });
    await execFileAsync("sh", ["-c", "echo adp-side > diverge.txt"], { cwd: adpClone });
    await execFileAsync("git", ["add", "."], { cwd: adpClone });
    await execFileAsync("git", ["commit", "-m", "adp-side commit"], { cwd: adpClone });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: adpClone });
    const adpSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: adpClone })).stdout.trim();
    await rm(adpClone, { recursive: true, force: true });

    // ...and a different, conflicting commit straight on the mirror, from
    // the same prior tip.
    const priorSha = await githubStandIn.resolveRef(owner, repoName, "main");
    const ghClone = await mkdtemp(path.join(tmpdir(), "adp-e2e-mirror-div-gh-"));
    await execFileAsync("git", ["clone", githubStandIn.repoPath(owner, repoName), ghClone]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: ghClone });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: ghClone });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: ghClone });
    await execFileAsync("sh", ["-c", "echo gh-side > diverge.txt"], { cwd: ghClone });
    await execFileAsync("git", ["add", "."], { cwd: ghClone });
    await execFileAsync("git", ["commit", "-m", "github-side commit"], { cwd: ghClone });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: ghClone });
    const ghSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: ghClone })).stdout.trim();
    await rm(ghClone, { recursive: true, force: true });

    await new Promise((resolve) => setTimeout(resolve, 500));
    await pollOnce(db, gitBackend, CREDENTIAL_KEY);

    // The mirror's ref is untouched by the failed outbound push.
    expect(await githubStandIn.resolveRef(owner, repoName, "main")).toBe(ghSha);

    const [failedOutbound] = await db
      .select()
      .from(mirrorSyncLog)
      .where(and(eq(mirrorSyncLog.direction, "outbound"), eq(mirrorSyncLog.sha, adpSha)));
    expect(failedOutbound?.status).toBe("failed");

    const payload = JSON.stringify({ ref: "refs/heads/main", after: ghSha });
    const signature = "sha256=" + createHmac("sha256", webhook_secret).update(payload).digest("hex");
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github/${owner}/${repoName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
      body: payload,
    });
    const body = (await res.json()) as { ok: boolean; reason?: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("diverged");

    // ADP's ref is untouched by the failed inbound fetch.
    expect(await gitBackend.resolveRef(owner, repoName, "main")).toBe(adpSha);
    void priorSha;
  });
});
