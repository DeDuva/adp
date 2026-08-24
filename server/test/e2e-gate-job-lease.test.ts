import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, desc, eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { identities, gateJobs, operations } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { GATE_JOB_LEASE_GRACE_MS } from "../src/core/gate-jobs.js";
import { sweepExpiredGateJobs, GATE_JOB_MAX_ATTEMPTS } from "../src/core/gate-job-reaper.js";
import { findOrCreateSystemIdentity } from "../src/core/system-identity.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerGateJobRoutes } from "../src/http-rest/gate-jobs.js";

// #92: a claim is a lease, the
// reaper is the recovery path, and both ends of the lifecycle write the
// operation log. Before this, a runner that died after claiming left its
// job `running` forever — gates_green blocked that commit's land
// permanently, the job held one of its org's concurrency slots, and
// complete 409s on a non-running job, so there was no recovery short of
// psql. Lease expiry is forced through the DB here rather than waited for:
// the shortest honest lease is timeout + grace, which is minutes, and what
// these tests prove is the reaper's decision logic and the requeued job's
// full second life — not that Date.now() advances.
describe.skipIf(skipWithoutDb)("#92: gate-job lease and reaper", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let writeToken: string;
  let runnerAToken: string;
  let runnerAId: string;
  let runnerBToken: string;
  let runnerBId: string;
  let reaperActorId: string;
  const owner = `lease-owner-${Date.now()}`;

  async function api(pathAndQuery: string, token: string, init: RequestInit = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }

  async function jobRow(id: string) {
    const [row] = await db.select().from(gateJobs).where(eq(gateJobs.id, id));
    return row!;
  }

  // Reclaim our own target out of whoever's hands, but never resurrect a
  // job that already reached a terminal state.
  async function reclaimTarget(id: string) {
    await db
      .update(gateJobs)
      .set({ status: "queued", claimedBy: null, claimedByIdentityId: null, startedAt: null, leaseExpiresAt: null })
      .where(and(eq(gateJobs.id, id), eq(gateJobs.status, "running")));
  }

  // Release a foreign job this hunt popped — ONLY if we still hold it. The
  // owning file may have force-reclaimed it from us mid-hunt (their right);
  // an unconditional requeue here would yank it back out of their claim
  // mid-test.
  async function releaseHeld(id: string, holderIdentityId: string) {
    await db
      .update(gateJobs)
      .set({ status: "queued", claimedBy: null, claimedByIdentityId: null, startedAt: null, leaseExpiresAt: null })
      .where(and(eq(gateJobs.id, id), eq(gateJobs.status, "running"), eq(gateJobs.claimedByIdentityId, holderIdentityId)));
  }

  // Same shared-queue reality every e2e-gate-jobs* file lives with: another
  // file's claim polling can win any claim call. Loop toward OUR job with
  // the given token, requeueing it directly in the DB if a foreign identity
  // took it (legitimate: this test enqueued and owns these rows).
  //
  // Foreign jobs this loop pops are HELD until the hunt ends, then handed
  // back — both halves matter. Requeueing a foreign job immediately would
  // livelock: claim serves oldest-first and a requeued job keeps its
  // original created_at, so the very next claim pops the same row again and
  // the loop never reaches its own newer job. Abandoning them wedges the
  // owning file's loop instead (the pre-#92 starvation). Holding briefly
  // and releasing in finally starves nobody: the owner's own loop
  // force-requeues its target out of our hands exactly as we do ours.
  async function claimOurs(jobId: string, token: string, ourIdentityId: string, maxAttempts = 100) {
    const held: string[] = [];
    try {
      for (let i = 0; i < maxAttempts; i++) {
        const row = await jobRow(jobId);
        if (row.status === "running" && row.claimedByIdentityId === ourIdentityId) return;
        if (row.status === "running") await reclaimTarget(jobId);
        const res = await api("/api/adp/gate-jobs/claim", token, {
          method: "POST",
          body: JSON.stringify({ claimed_by: `lease-${i}` }),
        });
        if (res.status === 200 && res.body!.id === jobId) return;
        if (res.status === 200) held.push(res.body!.id as string);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`claimOurs: ${jobId} never claimed by ${ourIdentityId}`);
    } finally {
      for (const id of held) await releaseHeld(id, ourIdentityId);
    }
  }

  async function enqueue(name: string): Promise<string> {
    const res = await api(`/api/adp/repos/${owner}/target/gate-jobs`, writeToken, {
      method: "POST",
      body: JSON.stringify({ git_sha: "c".repeat(40), name, image: "busybox:1", command: "true", timeout_ms: 60_000 }),
    });
    expect(res.status).toBe(201);
    return res.body!.id as string;
  }

  async function latestOp(verb: string, repoId: string) {
    const [op] = await db
      .select()
      .from(operations)
      .where(and(eq(operations.verb, verb), eq(operations.repoId, repoId)))
      .orderBy(desc(operations.createdAt))
      .limit(1);
    return op ?? null;
  }

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-lease-git-"));
    const gitBackend = new GitBackend(gitRoot);
    const signer = new Signer("e2e-lease-signing-key");

    app = Fastify({ logger: false });
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerGateJobRoutes(app, db, gitBackend, signer, "https://adp.example.com", "e2e-test-credential-key");

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [writer] = await db.insert(identities).values({ kind: "human", principal: `lease-writer-${Date.now()}` }).returning();
    writeToken = await mintToken(db, writer!.id, ["repo:write"]);
    await grantOwner(db, writer!.id, owner);

    const [runnerA] = await db.insert(identities).values({ kind: "agent", principal: `lease-runner-a-${Date.now()}` }).returning();
    runnerAId = runnerA!.id;
    runnerAToken = await mintToken(db, runnerA!.id, ["runner"]);
    const [runnerB] = await db.insert(identities).values({ kind: "agent", principal: `lease-runner-b-${Date.now()}` }).returning();
    runnerBId = runnerB!.id;
    runnerBToken = await mintToken(db, runnerB!.id, ["runner"]);

    reaperActorId = await findOrCreateSystemIdentity(db, "system:gate-job-reaper");

    await api(`/api/v3/repos/${owner}`, writeToken, { method: "POST", body: JSON.stringify({ name: "target" }) });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("a claim takes a lease (timeout + grace), counts the attempt, and records a gate_job.claim operation", async () => {
    const jobId = await enqueue("lease-shape");
    await claimOurs(jobId, runnerAToken, runnerAId);

    const row = await jobRow(jobId);
    expect(row.attempts).toBeGreaterThanOrEqual(1);
    expect(row.leaseExpiresAt).not.toBeNull();
    const leaseMs = row.leaseExpiresAt!.getTime() - row.startedAt!.getTime();
    expect(leaseMs).toBe(row.timeoutMs + GATE_JOB_LEASE_GRACE_MS);

    const claimOp = await latestOp("gate_job.claim", row.repoId);
    expect(claimOp).not.toBeNull();
    expect(claimOp!.actorId).toBe(runnerAId);

    // Leave the queue clean.
    await api(`/api/adp/gate-jobs/${jobId}/complete`, runnerAToken, {
      method: "POST",
      body: JSON.stringify({ status: "succeeded" }),
    });
  });

  it("an expired lease is requeued with an operation, and the job lives a full second life under a new runner", async () => {
    const jobId = await enqueue("second-life");
    await claimOurs(jobId, runnerAToken, runnerAId);

    // Runner A "dies": nothing completes the job, the lease lapses.
    // attempts is pinned to 1 along with the backdate — every claim
    // increments it, and the steal/reclaim churn of concurrent files'
    // hunts can have claimed this job several times on its way to us; the
    // scenario under test is "the FIRST attempt's lease expired", not
    // "however many claims the suite's traffic happened to make".
    await db
      .update(gateJobs)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000), attempts: 1 })
      .where(eq(gateJobs.id, jobId));

    // A handful of tries, not one: the sweep's FOR UPDATE SKIP LOCKED can
    // transiently skip our row while a concurrent test file's transaction
    // holds locks — correct behavior for the reaper (the next tick gets
    // it), so the test models the next tick.
    let requeuedTotal = 0;
    for (let i = 0; i < 10; i++) {
      requeuedTotal += (await sweepExpiredGateJobs(db, reaperActorId)).requeued;
      if ((await jobRow(jobId)).status === "queued") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(requeuedTotal).toBeGreaterThanOrEqual(1);

    const afterSweep = await jobRow(jobId);
    expect(afterSweep.status).toBe("queued");
    expect(afterSweep.claimedBy).toBeNull();
    expect(afterSweep.claimedByIdentityId).toBeNull();
    expect(afterSweep.startedAt).toBeNull();
    expect(afterSweep.leaseExpiresAt).toBeNull();

    const requeueOp = await latestOp("gate_job.requeue", afterSweep.repoId);
    expect(requeueOp).not.toBeNull();
    expect(requeueOp!.actorId).toBe(reaperActorId);

    // A different runner claims the requeued job and completes it — #88's
    // ownership check now binds to B, which is the point of clearing the
    // claim fields rather than merely flipping status.
    await claimOurs(jobId, runnerBToken, runnerBId);
    const reclaimed = await jobRow(jobId);
    expect(reclaimed.claimedByIdentityId).toBe(runnerBId);
    expect(reclaimed.attempts).toBeGreaterThanOrEqual(2);

    const completed = await api(`/api/adp/gate-jobs/${jobId}/complete`, runnerBToken, {
      method: "POST",
      body: JSON.stringify({ status: "succeeded", exit_code: 0 }),
    });
    expect(completed.status).toBe(200);
  });

  it("at the retry cap the job is marked error with a gate_job.expire operation, not requeued forever", async () => {
    const jobId = await enqueue("give-up");
    await claimOurs(jobId, runnerAToken, runnerAId);
    await db
      .update(gateJobs)
      .set({ attempts: GATE_JOB_MAX_ATTEMPTS, leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(gateJobs.id, jobId));

    // Same next-tick modeling as the requeue test: SKIP LOCKED may
    // transiently defer our row to a later sweep.
    let erroredTotal = 0;
    for (let i = 0; i < 10; i++) {
      erroredTotal += (await sweepExpiredGateJobs(db, reaperActorId)).errored;
      if ((await jobRow(jobId)).status === "error") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(erroredTotal).toBeGreaterThanOrEqual(1);

    const row = await jobRow(jobId);
    expect(row.status).toBe("error");
    expect(row.finishedAt).not.toBeNull();
    expect(row.logs).toContain("[reaper] lease expired");

    const expireOp = await latestOp("gate_job.expire", row.repoId);
    expect(expireOp).not.toBeNull();
    expect(expireOp!.actorId).toBe(reaperActorId);

    // Terminal means terminal: the reaper never touches it again, and
    // complete refuses it like any other finished job.
    const again = await sweepExpiredGateJobs(db, reaperActorId);
    expect((await jobRow(jobId)).status).toBe("error");
    expect(again).toBeDefined();
    const lateComplete = await api(`/api/adp/gate-jobs/${jobId}/complete`, runnerAToken, {
      method: "POST",
      body: JSON.stringify({ status: "succeeded" }),
    });
    expect(lateComplete.status).toBe(409);
  });
});
