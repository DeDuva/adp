import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { identities, orgs, gateJobs } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerGateJobRoutes } from "../src/http-rest/gate-jobs.js";

// M4-9d: claim skips a queued job whose org
// is at its maxConcurrentGateJobs ceiling rather than refusing the whole
// claim — proven through the real claim route, against real Postgres, the
// way M4-3's own quota tests (e2e-quotas.test.ts) prove maxRepos and
// maxConcurrentWorkspaces.
describe.skipIf(skipWithoutDb)("M4-9d: gate-job org concurrency quota", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let writeToken: string;
  let writerId: string;
  let runnerToken: string;

  async function api(pathAndQuery: string, init: RequestInit = {}, token = writeToken) {
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

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-gate-job-quotas-git-"));
    const gitBackend = new GitBackend(gitRoot);
    const signer = new Signer("e2e-gate-job-quotas-signing-key");

    app = Fastify({ logger: false });
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerGateJobRoutes(app, db, gitBackend, signer, "https://adp.example.com", "e2e-test-credential-key");

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [writer] = await db.insert(identities).values({ kind: "human", principal: `gjq-writer-${Date.now()}` }).returning();
    writerId = writer!.id;
    writeToken = await mintToken(db, writer!.id, ["repo:write"]);

    const [runner] = await db.insert(identities).values({ kind: "agent", principal: `gjq-runner-${Date.now()}` }).returning();
    runnerToken = await mintToken(db, runner!.id, ["runner"]);

    // Deliberately no "drain the queue first" step here (an earlier version
    // had one): claim is instance-wide and shared with every other e2e file
    // vitest runs concurrently against this same database, so draining by
    // claiming-and-completing everything in sight would complete jobs that
    // belong to those other, still-in-flight tests — corrupting them, not
    // cleaning up after them. This file's own tests identify their jobs by
    // id and poll each one's specific status (driveUntilClaimed below)
    // rather than assuming the queue starts empty, so no drain is needed.
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  async function enqueue(owner: string, repoName: string, name: string) {
    const res = await api(`/api/adp/repos/${owner}/${repoName}/gate-jobs`, {
      method: "POST",
      body: JSON.stringify({ git_sha: "a".repeat(40), name, image: "busybox:1", command: "true" }),
    });
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  }

  // Directly in the DB, not through /complete: since #88 that route only
  // serves the identity that claimed the job, and "whoever's claim polling
  // got there first" is exactly who holds jobs in this shared-queue suite —
  // possibly another file's identity. This test only needs the org's
  // capacity slot freed (the cap counts `running` rows); the complete
  // route's own semantics are e2e-gate-jobs.test.ts's business.
  async function forceComplete(id: string) {
    await db.update(gateJobs).set({ status: "succeeded", finishedAt: new Date() }).where(eq(gateJobs.id, id));
  }

  async function jobStatus(id: string): Promise<string> {
    const [row] = await db.select({ status: gateJobs.status }).from(gateJobs).where(eq(gateJobs.id, id));
    return row!.status;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Claim is a truly shared, instance-wide, first-come-first-served
  // resource, and this suite runs test files concurrently against one
  // database — another file's own claim polling can legitimately claim one
  // of *this* test's jobs before this test's own next claim call runs. That
  // is not a bug; it means an assertion of the form "this test's own Nth
  // claim call returns job X" is the wrong thing to assert here. What the
  // server actually enforces — and what these tests exist to prove — is
  // independent of *who* calls claim(), so this drives claim() calls itself
  // while polling `targetId`'s real DB status, until it's no longer `queued`.
  //
  // Deliberately does *not* complete a foreign job it happens to claim while
  // draining toward its own target — an earlier version did, and that
  // measurably corrupted other e2e-gate-jobs* files' own tests (their job
  // would show up already `succeeded` by the time their own claim/complete
  // calls ran). Leaving a drained foreign job at `running` is not free
  // either — it still takes the claim away from whichever test enqueued it —
  // but it doesn't also falsify that job's *final* state, and it costs
  // nothing extra: once claimed, a row is never selected by claim() again
  // regardless of whether anyone ever completes it.
  async function driveUntilClaimed(targetId: string, maxAttempts = 40): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      if ((await jobStatus(targetId)) !== "queued") return;
      await api("/api/adp/gate-jobs/claim", { method: "POST", body: JSON.stringify({ claimed_by: `driver-${i}` }) }, runnerToken);
      await sleep(50);
    }
    throw new Error(`driveUntilClaimed: ${targetId} never left 'queued' after ${maxAttempts} attempts`);
  }

  it("blocks a queued job while its org is at the concurrency cap, never blocks a different org's job, and admits the blocked job once capacity frees up", async () => {
    const ownerA = `gjq-org-a-${Date.now()}`;
    const ownerB = `gjq-org-b-${Date.now()}`;
    await db.insert(orgs).values({ name: ownerA, maxConcurrentGateJobs: 1 });
    await db.insert(orgs).values({ name: ownerB }); // unlimited
    // #91: the orgs exist (above, with their caps) but the writer must also
    // be a member to create repos and enqueue in them.
    await grantOwner(db, writerId, ownerA);
    await grantOwner(db, writerId, ownerB);

    await api(`/api/v3/repos/${ownerA}`, { method: "POST", body: JSON.stringify({ name: "repo-a" }) });
    await api(`/api/v3/repos/${ownerB}`, { method: "POST", body: JSON.stringify({ name: "repo-b" }) });

    const a1 = await enqueue(ownerA, "repo-a", "a1");
    const a2 = await enqueue(ownerA, "repo-a", "a2");
    const b1 = await enqueue(ownerB, "repo-b", "b1");

    // Someone (this test, or a concurrent file's own claim polling) claims
    // a1 — org A had zero running jobs, so nothing blocks it.
    await driveUntilClaimed(a1);

    // Org A is now at its cap of 1. Sample a2's real status repeatedly —
    // deliberately *not* issuing extra claim() calls of our own here: the
    // server enforces the cap for every caller uniformly, so if it were
    // broken, any of the natural claim() traffic other e2e files generate
    // during this window would surface it just as well, without this test
    // adding its own competing load (a version of this loop that did call
    // claim() here measurably increased how often it stole other files'
    // own just-enqueued jobs before they could claim them — the thing this
    // whole helper set exists to avoid doing to *itself*, being done to
    // someone else instead).
    for (let i = 0; i < 10; i++) {
      expect(await jobStatus(a2)).toBe("queued");
      await sleep(20);
    }
    // A *different* org's job (b1) must still be reachable in the meantime —
    // the naive "check the oldest queued job's org, refuse the whole claim
    // if it's over cap" behavior would incorrectly block b1 too, which is
    // exactly the starvation this design exists to avoid: the skip is scoped
    // to org A, not a blanket "someone's job is running" refusal.
    await driveUntilClaimed(b1);
    expect(await jobStatus(b1)).not.toBe("queued");

    // Whoever claimed a1 (possibly another file's identity), free org A's
    // slot so a2 becomes claimable.
    await forceComplete(a1);
    await driveUntilClaimed(a2);
    expect(await jobStatus(a2)).not.toBe("queued");
  });

  it("an org with no cap set is never blocked, regardless of how many of its jobs are running", async () => {
    const owner = `gjq-unlimited-${Date.now()}`;
    await db.insert(orgs).values({ name: owner }); // maxConcurrentGateJobs stays null
    await grantOwner(db, writerId, owner);
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: "repo" }) });

    const ids = [await enqueue(owner, "repo", "u1"), await enqueue(owner, "repo", "u2"), await enqueue(owner, "repo", "u3")];
    for (const id of ids) {
      await driveUntilClaimed(id);
      expect(await jobStatus(id)).not.toBe("queued");
    }
  });
});
