import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq, isNull } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { identities, operations, orgs, gateJobs } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { findRepo, repoAccessCheck } from "../src/core/repos-lookup.js";
import { measureOrgStorage, meterAllOrgs, pushQuotaCheck } from "../src/core/storage-usage.js";
import { renderMetrics, resetMetricsForTest } from "../src/core/telemetry.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerSessionRoutes } from "../src/http-rest/sessions.js";
import { registerGateJobRoutes } from "../src/http-rest/gate-jobs.js";
import { registerOrgRoutes } from "../src/http-rest/orgs.js";

const execFileAsync = promisify(execFile);
const SIGNING_KEY = "e2e-storage-quota-signing-key";
const PUBLIC_URL = "https://adp.example.com";

// M4-3, the half of the milestone that was never built (PLAN.md 1-3).
//
// The quota is deliberately *not* enforced uniformly, and most of what this
// file asserts is the shape of the exceptions rather than the happy refusal:
//
//   - writes that grow storage are refused (append, checkpoint, push);
//   - reads are never refused, because a quota that stops an org cloning what
//     it already has is a lockout, not a ceiling;
//   - gate-job completion is never refused — it drops its logs instead —
//     because the gate has already run, and refusing would leave the job
//     wedged until the reaper and its signed evidence never written, turning
//     a storage quota into a permanent land outage;
//   - an org that has never been metered is under quota, not over, because
//     `storage_bytes_used` is null until the first tick and failing closed on
//     null would refuse every write on every instance after every restart.
//
// Each of those is a decision that looks like a bug to anyone reading only
// the enforcement code, which is why each gets a test that fails if someone
// "fixes" it.
describe.skipIf(skipWithoutDb)("M4-3: per-org storage quota", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let gitBackend: GitBackend;
  let port: number;
  let token: string;
  let runnerToken: string;
  let runnerIdentityId: string;
  let identityId: string;

  async function api(pathAndQuery: string, init: RequestInit = {}, bearer = token) {
    const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
      ...init,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", ...init.headers },
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body: body as Record<string, unknown> };
  }

  // An org with one repo holding one real commit, pushed over the real git
  // wire — so the bytes the meter counts are bytes git actually wrote, not a
  // fixture's idea of them.
  async function seedOrg(slug: string): Promise<{ owner: string; orgId: string; gitSha: string }> {
    const owner = `${slug}-${Date.now()}`;
    const orgId = await grantOwner(db, identityId, owner);
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: "app" }) });

    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-storage-clone-"));
    await execFileAsync("git", ["clone", `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/app.git`, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo hi > f.txt"], { cwd: cloneDir });
    // #199: this file measures *bytes*, and under the default a trajectory
    // payload is stored as its shape rather than its content — 20 events of
    // ~1.4 KB each would come to a few hundred bytes, and every assertion here
    // about what an org is billed for would be measuring the projection
    // instead of the payload. The ceiling and the quota exist for repos that
    // keep what they record, so that is the repo this seeds.
    await writeFile(path.join(cloneDir, "adp.yaml"), "trajectory:\n  payloads: full\n");
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: cloneDir });
    await rm(cloneDir, { recursive: true, force: true });

    return { owner, orgId, gitSha: stdout.trim() };
  }

  async function startSession(owner: string): Promise<string> {
    const res = await api(`/api/adp/repos/${owner}/app/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "e2e" }),
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-storage-git-"));
    gitBackend = new GitBackend(gitRoot);
    const signer = new Signer(SIGNING_KEY);

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, PUBLIC_URL);
    registerSessionRoutes(app, db, gitBackend, signer, PUBLIC_URL);
    registerGateJobRoutes(app, db, gitBackend, signer, PUBLIC_URL, "e2e-storage-credential-key");
    registerOrgRoutes(app, db, gitBackend, []);
    // The proxy gets the real quota callback, not a stub — the push refusal
    // below has to travel the same wiring routes.ts uses in production.
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend, undefined, pushQuotaCheck(db));

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;
    gitBackend.setInternalUrl(`http://127.0.0.1:${port}`);

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `storage-e2e-${Date.now()}` })
      .returning();
    identityId = identity!.id;
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);

    const [runner] = await db
      .insert(identities)
      .values({ kind: "agent", principal: `storage-e2e-runner-${Date.now()}` })
      .returning();
    runnerIdentityId = runner!.id;
    runnerToken = await mintToken(db, runner!.id, ["runner"]);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  // Every test here gets 120_000, matching the eight other git-heavy e2e files
  // rather than the 20s global (#169). `seedOrg` clones over the real git wire,
  // commits and pushes — and the first test does it twice — so a test that
  // costs 2-3s alone costs over 20s when sixteen workers are all spawning
  // `git` at once. The file used to take the global, and flaked on a different
  // test each full-suite run, which is the shape of noise that gets re-run
  // until green. Nothing here is slow on its own: measured against a database
  // already holding 57 orgs from the rest of the tier, the whole file is 11s
  // and `meterAllOrgs` is 400ms.
  it("measures both halves of an org's storage, and attributes neither to another org", async () => {
    const mine = await seedOrg("storage-measure-mine");
    const theirs = await seedOrg("storage-measure-theirs");

    const sessionId = await startSession(mine.owner);
    const appended = await api(`/api/adp/repos/${mine.owner}/app/sessions/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({
        events: Array.from({ length: 20 }, (_, i) => ({
          kind: "message",
          type: "assistant",
          payload: { text: `event ${i} `.repeat(200) },
        })),
      }),
    });
    expect(appended.status).toBe(201);

    const measured = await measureOrgStorage(db, gitBackend, mine.orgId);
    // Both halves are real: rows in Postgres, and objects git wrote to disk.
    // A meter that counted only one would under-report by the larger share
    // for a source-heavy org and by the smaller for a trajectory-heavy one,
    // and there is no way to tell which an instance has without both.
    expect(measured.postgresBytes).toBeGreaterThan(0);
    expect(measured.gitBytes).toBeGreaterThan(0);
    expect(measured.totalBytes).toBe(measured.postgresBytes + measured.gitBytes);

    // The 20 events carry ~1.4 KB of payload each; an org that did not write
    // them must not be billed for them. This is the tenancy property the
    // whole quota rests on — a meter that summed the *table* would refuse
    // one org's writes because another org was noisy.
    const neighbour = await measureOrgStorage(db, gitBackend, theirs.orgId);
    expect(measured.postgresBytes).toBeGreaterThan(neighbour.postgresBytes + 20_000);
  }, 120_000);

  it("writes the reading onto the org and publishes it as adp_storage_bytes", async () => {
    const { owner, orgId } = await seedOrg("storage-meter-tick");
    resetMetricsForTest();

    const before = (await db.select().from(orgs).where(eq(orgs.id, orgId)))[0]!;
    expect(before.storageBytesUsed).toBeNull();
    expect(before.storageMeasuredAt).toBeNull();

    await meterAllOrgs(db, gitBackend);

    const after = (await db.select().from(orgs).where(eq(orgs.id, orgId)))[0]!;
    expect(after.storageBytesUsed).toBeGreaterThan(0);
    expect(after.storageMeasuredAt).toBeInstanceOf(Date);

    // The gauge the storage analysis found had no counterpart at all: before
    // M4-3 there were zero storage metrics, so growth was invisible until it
    // was fatal.
    const metrics = renderMetrics();
    expect(metrics).toContain("# TYPE adp_storage_bytes gauge");
    expect(metrics).toContain(`adp_storage_bytes{org="${owner}"} ${after.storageBytesUsed}`);
  }, 120_000);

  it("refuses a trajectory append and a checkpoint once the org is over its ceiling", async () => {
    const { owner, orgId, gitSha } = await seedOrg("storage-over");
    const sessionId = await startSession(owner);
    await meterAllOrgs(db, gitBackend);

    // A ceiling of 1 byte against a measured org: over, by any reading.
    await db.update(orgs).set({ maxStorageBytes: 1 }).where(eq(orgs.id, orgId));

    const append = await api(`/api/adp/repos/${owner}/app/sessions/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({ events: [{ kind: "message", type: "assistant", payload: { text: "hi" } }] }),
    });
    expect(append.status).toBe(403);
    expect(append.body.message).toMatch(/storage quota exceeded/i);

    const checkpoint = await api(`/api/adp/repos/${owner}/app/sessions/${sessionId}/checkpoints`, {
      method: "POST",
      body: JSON.stringify({ git_sha: gitSha, harness: "e2e", state: { note: "should not be stored" } }),
    });
    expect(checkpoint.status).toBe(403);
    expect(checkpoint.body.message).toMatch(/storage quota exceeded/i);
  }, 120_000);

  it("refuses a push over the ceiling but never a clone — a quota is not a lockout", async () => {
    const { owner, orgId } = await seedOrg("storage-push");
    await meterAllOrgs(db, gitBackend);
    await db.update(orgs).set({ maxStorageBytes: 1 }).where(eq(orgs.id, orgId));

    // Reads keep working: an org at its ceiling must still be able to get at
    // what it already stored, or the quota has taken the data hostage.
    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-storage-clone-"));
    await execFileAsync("git", [
      "clone",
      `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/app.git`,
      cloneDir,
    ]);

    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo more > g.txt"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "second"], { cwd: cloneDir });

    // Asserted on the message, not merely on "it threw": a push can fail for
    // a dozen reasons that have nothing to do with a quota, and a test that
    // accepts any of them would keep passing after the check was removed.
    const pushed = await execFileAsync("git", ["push", "origin", "HEAD:main"], { cwd: cloneDir }).then(
      () => null,
      (err: { stderr?: string; message?: string }) => `${err.stderr ?? ""}${err.message ?? ""}`,
    );
    expect(pushed).not.toBeNull();
    expect(pushed).toMatch(/403/);
    await rm(cloneDir, { recursive: true, force: true });
  }, 120_000);

  // The decision that most looks like a bug from the enforcement code alone.
  it("does not refuse an org that has never been metered — null used is unknown, not over", async () => {
    const { owner, orgId } = await seedOrg("storage-unmetered");
    const sessionId = await startSession(owner);

    // A ceiling set by an operator seconds after the org was created, before
    // any meter tick has run against it. Failing closed here would mean every
    // instance refused every write for one interval after every restart.
    await db.update(orgs).set({ maxStorageBytes: 1 }).where(eq(orgs.id, orgId));
    const org = (await db.select().from(orgs).where(eq(orgs.id, orgId)))[0]!;
    expect(org.storageBytesUsed).toBeNull();

    const append = await api(`/api/adp/repos/${owner}/app/sessions/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({ events: [{ kind: "message", type: "assistant", payload: { text: "hi" } }] }),
    });
    expect(append.status).toBe(201);
  }, 120_000);

  // The other one: a storage quota must never become a land outage.
  it("completes a gate job over the ceiling, dropping its logs and saying so in the op log", async () => {
    const { owner, orgId, gitSha } = await seedOrg("storage-gate-logs");

    const enqueued = await api(`/api/adp/repos/${owner}/app/gate-jobs`, {
      method: "POST",
      body: JSON.stringify({ git_sha: gitSha, name: "unit", image: "node:22", command: "true", timeout_ms: 60000 }),
    });
    expect(enqueued.status).toBe(201);
    const jobId = enqueued.body.id as string;

    // Put the job in the state a claim leaves it in, directly. Going through
    // /claim would mean polling an instance-wide queue this file shares with
    // every other e2e file — which both races (another file's job is handed
    // back instead) and steals (this file's poll claims jobs those files are
    // waiting on). The claim path has its own tests; what is under test here
    // is what /complete does with `logs` when the org is over its ceiling.
    const now = new Date();
    await db
      .update(gateJobs)
      .set({
        status: "running",
        claimedBy: "storage-runner",
        claimedByIdentityId: runnerIdentityId,
        startedAt: now,
        leaseExpiresAt: new Date(now.getTime() + 600_000),
      })
      .where(eq(gateJobs.id, jobId));

    await meterAllOrgs(db, gitBackend);
    await db.update(orgs).set({ maxStorageBytes: 1 }).where(eq(orgs.id, orgId));

    const completed = await api(
      `/api/adp/gate-jobs/${jobId}/complete`,
      { method: "POST", body: JSON.stringify({ status: "succeeded", exit_code: 0, logs: "x".repeat(50_000) }) },
      runnerToken,
    );
    // Completed, not refused: the gate ran, and the evidence land policy
    // reads is a few hundred bytes. Refusing would wedge the job until the
    // reaper and block the commit permanently.
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe("succeeded");

    const [row] = await db.select().from(gateJobs).where(eq(gateJobs.id, jobId));
    expect(row!.status).toBe("succeeded");
    expect(row!.logs).toBeNull();

    // Why the logs are empty is answerable from the op log, so it reads as a
    // decision rather than as data loss.
    const [op] = await db
      .select()
      .from(operations)
      .where(and(eq(operations.verb, "gate_job.complete"), eq(operations.repoId, (await findRepo(db, owner, "app"))!.id)));
    expect((op!.after as Record<string, unknown>).logs_dropped).toBe("org storage quota");
  }, 120_000);

  it("serves the ceiling and its measurement age on the org console, and audits a change to it", async () => {
    const { orgId } = await seedOrg("storage-console");
    await meterAllOrgs(db, gitBackend);

    // requireOrgAccess grants only where the *token* is scoped to the org —
    // the token carries the grant, not the person — so the console needs an
    // org-scoped admin token even for an identity that is already a member.
    const orgToken = await mintToken(db, identityId, ["repo:read", "admin"], { orgId });

    const patched = await api(
      `/api/adp/orgs/${orgId}`,
      { method: "PATCH", body: JSON.stringify({ max_storage_bytes: 5_000_000_000 }) },
      orgToken,
    );
    expect(patched.status).toBe(200);
    // Five gigabytes: an ordinary ceiling, and one that would have silently
    // overflowed had this column been int4 like the three counting quotas.
    expect(patched.body.max_storage_bytes).toBe(5_000_000_000);

    const detail = await api(`/api/adp/orgs/${orgId}`, {}, orgToken);
    const quotas = detail.body.quotas as Record<string, Record<string, unknown>>;
    expect(quotas.max_storage_bytes!.limit).toBe(5_000_000_000);
    expect(quotas.max_storage_bytes!.used).toBeGreaterThan(0);
    // Served with the reading, because `used` is stale by up to one meter
    // interval and a client showing it without its age is showing a number
    // whose age it does not know.
    expect(typeof quotas.max_storage_bytes!.measured_at).toBe("string");

    const [op] = await db
      .select()
      .from(operations)
      .where(and(eq(operations.verb, "org.quota_update"), eq(operations.orgId, orgId), isNull(operations.repoId)));
    expect((op!.after as Record<string, unknown>).max_storage_bytes).toBe(5_000_000_000);
  }, 120_000);
});
