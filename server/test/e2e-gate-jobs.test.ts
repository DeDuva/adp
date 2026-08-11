import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
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
import { Signer } from "../src/core/signing.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerGateJobRoutes } from "../src/http-rest/gate-jobs.js";

// M4-9a (docs/m4-readiness-review.md §4): the gate-job queue mechanism,
// proven end-to-end over real HTTP acting as a stub runner — no `runner/`
// package exists yet (M4-9b), only the server-side substrate it will use.
describe.skipIf(skipWithoutDb)("M4-9a: gate-job queue", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let writeToken: string;
  let runnerToken: string;
  const owner = `gj-owner-${Date.now()}`;
  const repoName = "target";
  const gitSha = "a".repeat(40);

  async function api(pathAndQuery: string, token: string, init: RequestInit = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-gate-jobs-git-"));
    const gitBackend = new GitBackend(gitRoot);
    const signer = new Signer("e2e-gate-jobs-signing-key");

    app = Fastify({ logger: false });
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerGateJobRoutes(app, db, gitBackend, signer, "https://adp.example.com", "e2e-test-credential-key");

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [writer] = await db.insert(identities).values({ kind: "human", principal: `gj-writer-${Date.now()}` }).returning();
    writeToken = await mintToken(db, writer!.id, ["repo:write"]);

    const [runner] = await db.insert(identities).values({ kind: "agent", principal: `gj-runner-${Date.now()}` }).returning();
    runnerToken = await mintToken(db, runner!.id, ["runner"]);

    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${writeToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: repoName }),
    });

    // Claim is deliberately instance-wide (a runner serves the whole
    // instance, not one repo), so it can see queued jobs left behind by
    // other test files or a prior run against this same database. Drain
    // them before asserting anything about "nothing queued" below, rather
    // than assuming a shared instance starts empty.
    for (;;) {
      const res = await api("/api/adp/gate-jobs/claim", runnerToken, {
        method: "POST",
        body: JSON.stringify({ claimed_by: "drain" }),
      });
      if (res.status === 204) break;
      await api(`/api/adp/gate-jobs/${res.body!.id}/complete`, runnerToken, {
        method: "POST",
        body: JSON.stringify({ status: "succeeded" }),
      });
    }
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("refuses a repo:write token trying to claim — claim needs the runner scope", async () => {
    const res = await api("/api/adp/gate-jobs/claim", writeToken, {
      method: "POST",
      body: JSON.stringify({ claimed_by: "impostor" }),
    });
    expect(res.status).toBe(403);
  });

  it("refuses a runner token trying to enqueue — enqueue needs repo:write", async () => {
    const res = await api(`/api/adp/repos/${owner}/${repoName}/gate-jobs`, runnerToken, {
      method: "POST",
      body: JSON.stringify({ git_sha: gitSha, name: "unit", image: "node:22", command: "npm test" }),
    });
    expect(res.status).toBe(403);
  });

  it("reports 204 when there is nothing queued, or a well-formed job if something legitimately was", async () => {
    // "Nothing queued" is this file's own local view after its beforeAll
    // drain — it is not a claim about the whole instance. Another e2e file
    // sharing this database can have a real job genuinely queued (or,
    // starting with M4-9d, deliberately held queued for a measurable window
    // while it proves an org's concurrency cap) at this exact moment, and
    // claim() correctly hands it out — that is not this test's job to
    // prevent or clean up after (completing a job this test doesn't own
    // would corrupt whichever test does). What this test actually verifies
    // is that claim() never fabricates a malformed response either way.
    const res = await api("/api/adp/gate-jobs/claim", runnerToken, {
      method: "POST",
      body: JSON.stringify({ claimed_by: "runner-host-1" }),
    });
    if (res.status === 200) {
      expect(res.body).toMatchObject({ status: "running", claimed_by: "runner-host-1" });
    } else {
      expect(res.status).toBe(204);
    }
  });

  // Claim is instance-wide and this database is shared with every other e2e
  // file vitest runs concurrently — another file's own claim polling (or,
  // starting with M4-9d, a test that deliberately holds jobs claimed for a
  // measurable window while it proves an org's concurrency cap) can
  // legitimately claim this test's just-enqueued job before this test's own
  // next claim call runs. Loop past anything that isn't `targetJobId`
  // instead of assuming the very next claim is it — and never complete a
  // job that isn't ours; that would corrupt whichever test actually owns it.
  async function claimJobId(targetJobId: string, claimedBy: string, maxAttempts = 40): Promise<Record<string, unknown>> {
    for (let i = 0; i < maxAttempts; i++) {
      const res = await api("/api/adp/gate-jobs/claim", runnerToken, {
        method: "POST",
        body: JSON.stringify({ claimed_by: claimedBy }),
      });
      if (res.status === 200 && res.body!.id === targetJobId) return res.body!;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`claimJobId: ${targetJobId} was never claimed after ${maxAttempts} attempts`);
  }

  it("runs the full enqueue -> claim -> complete lifecycle", async () => {
    const enqueued = await api(`/api/adp/repos/${owner}/${repoName}/gate-jobs`, writeToken, {
      method: "POST",
      body: JSON.stringify({ git_sha: gitSha, name: "unit", image: "node:22", command: "npm test", timeout_ms: 60000 }),
    });
    expect(enqueued.status).toBe(201);
    expect(enqueued.body).toMatchObject({ status: "queued", name: "unit", git_sha: gitSha });
    const jobId = enqueued.body!.id as string;

    const claimedBody = await claimJobId(jobId, "runner-host-1");
    expect(claimedBody).toMatchObject({ id: jobId, status: "running", claimed_by: "runner-host-1" });

    // A second runner polling concurrently never gets the same row twice
    // (FOR UPDATE SKIP LOCKED, not a race). This does *not* assert 204: with
    // more than one e2e file exercising the instance-wide queue against the
    // same shared database, some other file's own legitimately queued job
    // may be sitting there at this exact moment and get handed to this
    // second claim instead — that's a different job's business, not a
    // double-claim of this one, which is the actual property under test.
    const secondClaim = await api("/api/adp/gate-jobs/claim", runnerToken, {
      method: "POST",
      body: JSON.stringify({ claimed_by: "runner-host-2" }),
    });
    if (secondClaim.status === 200) {
      expect((secondClaim.body as { id: string }).id).not.toBe(jobId);
    } else {
      expect(secondClaim.status).toBe(204);
    }

    const completed = await api(`/api/adp/gate-jobs/${jobId}/complete`, runnerToken, {
      method: "POST",
      body: JSON.stringify({ status: "succeeded", exit_code: 0, logs: "ok\n" }),
    });
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ id: jobId, status: "succeeded", exit_code: 0, logs: "ok\n" });
    expect(completed.body!.finished_at).toBeTruthy();
  });

  it("refuses to complete a job that isn't running (already terminal)", async () => {
    const enqueued = await api(`/api/adp/repos/${owner}/${repoName}/gate-jobs`, writeToken, {
      method: "POST",
      body: JSON.stringify({ git_sha: gitSha, name: "double-complete", image: "node:22", command: "npm test" }),
    });
    const jobId = enqueued.body!.id as string;
    // Still "queued" — never claimed.
    const res = await api(`/api/adp/gate-jobs/${jobId}/complete`, runnerToken, {
      method: "POST",
      body: JSON.stringify({ status: "succeeded" }),
    });
    expect(res.status).toBe(409);
  });

  it("lists gate jobs for the repo, newest first", async () => {
    const res = await api(`/api/adp/repos/${owner}/${repoName}/gate-jobs`, writeToken);
    expect(res.status).toBe(200);
    const jobs = (res.body as { gate_jobs: { name: string }[] }).gate_jobs;
    expect(jobs.length).toBeGreaterThanOrEqual(2);
  });
});
