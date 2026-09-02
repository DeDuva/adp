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
import { skipWithoutDb } from "./require-db.js";
import { changes, identities, mirrors, mirrorSyncLog, operations, repos } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { pollOnce } from "../src/core/mirror-poller.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { repoAccessCheck } from "../src/core/repos-lookup.js";
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
describe.skipIf(skipWithoutDb)("M2: mirror mode", () => {
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
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;
    gitBackend.setInternalUrl(`http://127.0.0.1:${port}`);

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `mirror-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);

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

  // #230: mirror inbound used to attribute every commit it recorded to
  // `mirror:github:<owner>/<name>` — a statement about how the record arrived,
  // written into the field that says who made the change. The push payload
  // names each commit's author by login, so where it does, that is who the
  // change is signed as having come from.
  //
  // The second half of this is the more important one. GitHub caps that array
  // at 20 and a first import walks history nothing was ever delivered for, so
  // the map is partial by construction — and a commit it does not cover has to
  // keep falling back to the mirror rather than being attributed to whoever
  // happened to be resolved last.
  it("inbound: attributes each commit to the author the payload names, and falls back where it names none", async () => {
    const { webhook_secret } = await createMirror("inbound");

    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-mirror-attrib-"));
    await execFileAsync("git", ["clone", githubStandIn.repoPath(owner, repoName), cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "frank@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Frank"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo named > named.txt"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "named in the payload"], { cwd: cloneDir });
    const namedSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: cloneDir })).stdout.trim();
    await execFileAsync("sh", ["-c", "echo unnamed > unnamed.txt"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "not in the payload"], { cwd: cloneDir });
    const unnamedSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: cloneDir })).stdout.trim();
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    await rm(cloneDir, { recursive: true, force: true });

    // Only the first commit is named — exactly the shape of a push whose
    // commit list GitHub truncated.
    const payload = JSON.stringify({
      ref: "refs/heads/main",
      after: unnamedSha,
      commits: [{ id: namedSha, author: { username: "frank" } }],
    });
    const signature = "sha256=" + createHmac("sha256", webhook_secret).update(payload).digest("hex");
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github/${owner}/${repoName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
      body: payload,
    });
    expect(res.status).toBe(200);

    const [named] = await db.select().from(changes).where(eq(changes.gitSha, namedSha));
    expect((named!.provenance as { principal: string }).principal).toBe("github:frank");

    const [unnamed] = await db.select().from(changes).where(eq(changes.gitSha, unnamedSha));
    expect((unnamed!.provenance as { principal: string }).principal).toBe(`mirror:github:${owner}/${repoName}`);
  });

  // M2's exit criterion in its own words: "a mirrored repo with a >500-commit
  // history has a signed change recorded for every commit". The suite already
  // covered the *chunking* half (e2e-hooks.test.ts) but did so by pushing a
  // root commit first, deliberately stepping around the brand-new-ref path —
  // which is the only path a first mirror import ever takes. That path used to
  // record the tip commit and nothing else, so a repo mirrored in from GitHub
  // arrived with one signed change standing in for its entire history.
  //
  // Everything here is deliberately a repo ADP has never seen: its own bare
  // repo on the stand-in "GitHub" side, its own empty repo on the ADP side, and
  // a first webhook delivery for a branch that does not exist locally yet.
  it(
    "inbound first import: a >500-commit history ADP has never seen records a signed change per commit",
    async () => {
      const importRepo = "first-import";
      await githubStandIn.initBareRepo(owner, importRepo, "main");
      await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: importRepo }),
      });

      const res = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${importRepo}/mirror`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          remote_url: `file://${githubStandIn.repoPath(owner, importRepo)}`,
          direction: "inbound",
          credential: "unused-for-file-remote",
        }),
      });
      expect(res.status).toBe(201);
      const { webhook_secret } = (await res.json()) as { webhook_secret: string };

      // One more than RECORD_BATCH_SIZE (500, core/change-recorder.ts) so the
      // walk has to page rather than fit in a single `git log` call.
      //
      // Built directly in the stand-in bare repo with plumbing rather than by
      // cloning, committing 511 times and pushing. The clone-and-push version
      // worked locally and corrupted its own object graph in CI ("Could not
      // read <sha>" while traversing parents, then a truncated pack on the
      // wire) — and a test that flakes on the *setup* for a bug it is meant to
      // guard is worse than no test, because the next person reads the red as
      // noise. Plumbing writes the same objects with none of that surface.
      const HISTORY_LENGTH = 511;
      const blob = await githubStandIn.createBlob(owner, importRepo, Buffer.from("history\n", "utf8"));
      const tree = await githubStandIn.createTree(owner, importRepo, [
        { mode: "100644", type: "blob", sha: blob, path: "README.md" },
      ]);
      let sha = "";
      for (let i = 0; i < HISTORY_LENGTH; i++) {
        sha = await githubStandIn.createCommit(owner, importRepo, tree, sha ? [sha] : [], `history ${i}`, {
          name: "Test",
          email: "test@example.com",
        });
      }
      await githubStandIn.createRef(owner, importRepo, "refs/heads/main", sha);

      // ADP has no refs/heads/main for this repo at all — this is what makes
      // the webhook take the brand-new-ref path rather than a fast-forward.
      expect(await gitBackend.resolveRef(owner, importRepo, "main")).toBeNull();

      const payload = JSON.stringify({ ref: "refs/heads/main", after: sha });
      const signature = "sha256=" + createHmac("sha256", webhook_secret).update(payload).digest("hex");
      const hook = await fetch(`http://127.0.0.1:${port}/webhooks/github/${owner}/${importRepo}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
        body: payload,
      });
      expect(hook.status).toBe(200);
      expect(((await hook.json()) as { ok: boolean }).ok).toBe(true);

      const repoRow = await db.select().from(repos).where(and(eq(repos.owner, owner), eq(repos.name, importRepo)));
      const recorded = await db.select().from(changes).where(eq(changes.repoId, repoRow[0]!.id));
      expect(recorded).toHaveLength(HISTORY_LENGTH);
      // Signed, and attributed to the mirror rather than to a push — a record
      // that exists but is unsigned would satisfy a count and nothing else.
      for (const change of recorded) {
        expect(change.signature).toBeTruthy();
        expect((change.provenance as { via: string }).via).toBe("mirror-inbound");
      }

      await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${importRepo}/mirror`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    },
    180_000,
  );

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
