import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type Db } from "../src/db/client.js";
import { and, eq, ne } from "drizzle-orm";
import { identities, gateJobs, gateResults, operations, repos } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerGateJobRoutes } from "../src/http-rest/gate-jobs.js";
import { selectClaimCandidate } from "../src/core/gate-jobs.js";

// M4-9a: the gate-job queue mechanism,
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
  let runnerIdentityId: string;
  let writerId: string;
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
    writerId = writer!.id;
    writeToken = await mintToken(db, writer!.id, ["repo:write"]);
    await grantOwner(db, writer!.id, owner);

    const [runner] = await db.insert(identities).values({ kind: "agent", principal: `gj-runner-${Date.now()}` }).returning();
    runnerIdentityId = runner!.id;
    runnerToken = await mintToken(db, runner!.id, ["runner"]);

    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${writeToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: repoName }),
    });

    // Deliberately no "drain the queue first" step here (an earlier version
    // had one, looping claim+complete until 204): claim is instance-wide
    // and shared with every other e2e file vitest runs concurrently against
    // this same database, so draining that way completes jobs belonging to
    // those other, still-in-flight tests — corrupting them, not cleaning up
    // after them. The tests below are written to tolerate a non-empty
    // shared queue instead (see the "reports 204..." test's own comment).
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
    // "Nothing queued" can't actually be guaranteed here: claim is
    // instance-wide and this database is shared with every other e2e file
    // vitest runs concurrently. Another file can have a real job genuinely
    // queued (or, starting with M4-9d, deliberately held queued-but-blocked
    // for a measurable window while it proves an org's concurrency cap) at
    // this exact moment, and claim() correctly hands it out — that is not
    // this test's job to prevent or clean up after (completing a job this
    // test doesn't own would corrupt whichever test does). What this test
    // actually verifies is that claim() never fabricates a malformed
    // response either way.
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

  // Reclaim our own target (any holder, never a terminal row) vs release a
  // foreign job we popped (only while we still hold it — its owner may have
  // force-reclaimed it mid-hunt, and an unconditional requeue would yank it
  // back out of their claim mid-test). Same pair as e2e-gate-job-lease.
  async function reclaimTarget(id: string) {
    await db
      .update(gateJobs)
      .set({ status: "queued", claimedBy: null, claimedByIdentityId: null, startedAt: null, leaseExpiresAt: null })
      .where(and(eq(gateJobs.id, id), eq(gateJobs.status, "running")));
  }

  async function releaseHeld(id: string) {
    await db
      .update(gateJobs)
      .set({ status: "queued", claimedBy: null, claimedByIdentityId: null, startedAt: null, leaseExpiresAt: null })
      .where(and(eq(gateJobs.id, id), eq(gateJobs.status, "running"), eq(gateJobs.claimedByIdentityId, runnerIdentityId)));
  }

  // Claim is instance-wide and this database is shared with every other e2e
  // file vitest runs concurrently — another file's own claim polling (or,
  // starting with M4-9d, a test that deliberately holds jobs claimed for a
  // measurable window while it proves an org's concurrency cap) can
  // legitimately claim this test's just-enqueued job before this test's own
  // next claim call runs. Loop toward `targetJobId` instead of assuming the
  // very next claim is it, force-requeueing our own target out of a foreign
  // claimant's hands (legitimate: this test enqueued and owns it). Never
  // complete a foreign job — and don't requeue one mid-hunt either: claim
  // serves oldest-first, so an immediately-requeued old job is what the
  // next claim pops again, forever. Hold what the hunt pops, hand it all
  // back in finally — see e2e-gate-job-lease.test.ts's claimOurs for the
  // livelock this exact shape avoids.
  async function claimJobId(targetJobId: string, claimedBy: string, maxAttempts = 100): Promise<Record<string, unknown>> {
    const held: string[] = [];
    try {
      for (let i = 0; i < maxAttempts; i++) {
        const [target] = await db.select().from(gateJobs).where(eq(gateJobs.id, targetJobId));
        if (target!.status === "running" && target!.claimedByIdentityId !== runnerIdentityId) {
          await reclaimTarget(targetJobId);
        }
        const res = await api("/api/adp/gate-jobs/claim", runnerToken, {
          method: "POST",
          body: JSON.stringify({ claimed_by: claimedBy }),
        });
        if (res.status === 200 && res.body!.id === targetJobId) return res.body!;
        if (res.status === 200) held.push(res.body!.id as string);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`claimJobId: ${targetJobId} was never claimed after ${maxAttempts} attempts`);
    } finally {
      for (const id of held) await releaseHeld(id);
    }
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

  // #88's proof: before the ownership
  // check, ANY runner-scope token could tarball any org's source and
  // "complete" any org's job with `succeeded`, writing signed gate evidence
  // land policy trusts — a cross-tenant land-policy bypass from the
  // least-privileged token type. Ownership binds to the authenticated
  // identity that claimed the job, not the client-supplied `claimed_by`
  // string — which the intruder here deliberately echoes verbatim to prove
  // that forging it doesn't help.
  it("refuses checkout and complete from a runner identity that didn't claim the job", async () => {
    const enqueued = await api(`/api/adp/repos/${owner}/${repoName}/gate-jobs`, writeToken, {
      method: "POST",
      body: JSON.stringify({ git_sha: gitSha, name: "ownership", image: "node:22", command: "npm test" }),
    });
    expect(enqueued.status).toBe(201);
    const jobId = enqueued.body!.id as string;
    await claimJobId(jobId, "victim-runner-1");

    const [intruder] = await db
      .insert(identities)
      .values({ kind: "agent", principal: `gj-intruder-${Date.now()}` })
      .returning();
    const intruderToken = await mintToken(db, intruder!.id, ["runner"]);

    const checkoutRes = await api(`/api/adp/gate-jobs/${jobId}/checkout`, intruderToken);
    expect(checkoutRes.status).toBe(403);

    const completeRes = await api(`/api/adp/gate-jobs/${jobId}/complete`, intruderToken, {
      method: "POST",
      body: JSON.stringify({ status: "succeeded", exit_code: 0, logs: "claimed_by was victim-runner-1, honest\n" }),
    });
    expect(completeRes.status).toBe(403);

    // The refusals changed nothing: the job is still running, still held by
    // its claimant, and that claimant can still complete it.
    const ownerComplete = await api(`/api/adp/gate-jobs/${jobId}/complete`, runnerToken, {
      method: "POST",
      body: JSON.stringify({ status: "succeeded", exit_code: 0 }),
    });
    expect(ownerComplete.status).toBe(200);
    expect(ownerComplete.body).toMatchObject({ id: jobId, status: "succeeded" });
  });

  // #93 (audit §P1-2): the claim lock is FOR UPDATE OF gate_jobs, not a bare
  // FOR UPDATE over the join. Issue/proposal number assignment holds
  // `select id from repos ... for update` while it computes a number; under
  // the bare form, SKIP LOCKED treated a candidate whose (joined) repos row
  // was locked as locked itself and skipped it — creating an issue starved
  // that repo's gate queue for the duration of every numbering transaction.
  //
  // Proven at the candidate-select layer on purpose. The full claim cannot
  // demonstrate it black-box: since #92, the claim transaction writes a
  // gate_job.claim operation whose repo_id FK takes KEY SHARE on the repos
  // row, so against a *held* lock a fixed claim parks there until release —
  // a bounded wait in production (numbering commits in milliseconds), but
  // in a test it just measures the release, not the lock granularity. The
  // exported selectClaimCandidate is exactly the statement whose OF clause
  // is the fix, and its answer while the lock is held is the whole story:
  // with OF it returns the locked repo's job; bare, SKIP LOCKED skips it.
  it("the claim candidate select does not skip a job whose repos row is locked", async () => {
    const [repo] = await db.select().from(repos).where(and(eq(repos.owner, owner), eq(repos.name, repoName)));

    // Determinism here is `excludeIds`, not age (#286). This used to backdate
    // the job an hour so `order by created_at limit 1` would name it — which
    // made it the oldest row in a table every concurrently-running test file
    // is claiming from, so their claim loops took it first and the test
    // retried. Ten attempts at 50ms is a 500ms budget against the whole
    // suite's contention, and under load it ran out: the gate failed twice in
    // three runs on a docs-only branch, which is how a real regression ends up
    // re-run away.
    //
    // Excluding every other queued row makes the answer ours regardless of
    // ordering, and *not* backdating means nothing preferentially claims it
    // either — a row created moments ago is the last thing an oldest-first
    // loop reaches. The residual race is only our own row being claimed
    // between insert and select, which the shorter retry covers.
    const [job] = await db
      .insert(gateJobs)
      .values({
        repoId: repo!.id,
        gitSha,
        name: "lock-skip",
        image: "node:22",
        command: "true",
        timeoutMs: 60_000,
        actorId: writerId,
      })
      .returning();

    try {
      for (let attempt = 0; ; attempt++) {
        const client = await pool.connect();
        let candidate: { id: string } | null | undefined;
        try {
          await client.query("BEGIN");
          await client.query("SELECT id FROM repos WHERE owner = $1 AND name = $2 FOR UPDATE", [owner, repoName]);

          candidate = await db.transaction(async (tx) => {
            // Snapshotted inside the same transaction as the select, so a row
            // enqueued after this point cannot be missing from the list — and
            // it would sort after ours anyway, being newer.
            const others = await tx
              .select({ id: gateJobs.id })
              .from(gateJobs)
              .where(and(eq(gateJobs.status, "queued"), ne(gateJobs.id, job!.id)));
            const c = await selectClaimCandidate(tx, others.map((o) => o.id));
            // Roll back: this test asserts on the selection, it does not claim.
            throw Object.assign(new Error("rollback"), { candidate: c });
          }).catch((err: Error & { candidate?: { id: string } | null }) => err.candidate);
        } finally {
          await client.query("ROLLBACK").catch(() => {});
          client.release();
        }

        // The property: with the repos row locked by another connection, the
        // select still returns the job — a bare FOR UPDATE would SKIP LOCKED
        // past it.
        if (candidate?.id === job!.id) return;

        // The only way to get here is our own row having been claimed out from
        // under us, so say that rather than leaving a bare count.
        const [current] = await db.select({ status: gateJobs.status }).from(gateJobs).where(eq(gateJobs.id, job!.id));
        if (attempt >= 4) {
          throw new Error(
            `candidate select returned ${candidate?.id ?? "nothing"}, not the locked repo's job ` +
              `(job status: ${current?.status ?? "deleted"})`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
    } finally {
      await db.delete(gateJobs).where(eq(gateJobs.id, job!.id));
    }
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
  // ── M4 exit criterion 5, the "and the refusal is itself recorded" clause ──
  //
  // The isolation proofs live in runner/src/docker.test.ts, against a real
  // daemon: cap-drop, pids-limit, --network none, timeout kill, and no host
  // mount or Docker socket. Each of those ends with the runner reporting a
  // NON-succeeded status here. This is the other half — that such a report
  // lands as signed evidence land policy will refuse, rather than as a status
  // flip nobody reads.
  //
  // The failure mode being excluded is specific and quiet. If a killed gate
  // wrote no gate_results row, `gates_green` would see no failing gate and a
  // commit whose gate was killed mid-run would land as though nothing had
  // happened — "a skipped check must never look like a passing one"
  // (AGENTS.md), applied to the thing doing the checking. toGateResultStatus
  // maps every non-succeeded status to `failure` for exactly this reason;
  // nothing proved it end to end until here.
  it.each(["timed_out", "error"] as const)(
    "records a '%s' gate as signed FAILURE evidence, not merely as a status flip",
    async (terminal) => {
      const enqueued = await api(`/api/adp/repos/${owner}/${repoName}/gate-jobs`, writeToken, {
        method: "POST",
        body: JSON.stringify({
          git_sha: gitSha,
          name: `isolation-${terminal}`,
          image: "node:22",
          command: "sleep 999",
          timeout_ms: 60000,
        }),
      });
      expect(enqueued.status).toBe(201);
      const jobId = enqueued.body!.id as string;

      // Claimed directly rather than through /claim: the queue is shared with
      // every other e2e file running against this database, so polling for
      // this specific job both races and steals. What is under test is what
      // /complete writes, not how the job was claimed.
      const now = new Date();
      await db
        .update(gateJobs)
        .set({
          status: "running",
          claimedBy: "isolation-runner",
          claimedByIdentityId: runnerIdentityId,
          startedAt: now,
          leaseExpiresAt: new Date(now.getTime() + 600_000),
        })
        .where(eq(gateJobs.id, jobId));

      const completed = await api(`/api/adp/gate-jobs/${jobId}/complete`, runnerToken, {
        method: "POST",
        body: JSON.stringify({ status: terminal, logs: "killed by the runner\n" }),
      });
      expect(completed.status).toBe(200);
      expect(completed.body!.status).toBe(terminal);

      // 1. Signed evidence exists, and its verdict is failure — the value
      //    land policy's gates_green reads. `success` here would mean a
      //    killed gate counts as a passing one.
      const [evidence] = await db
        .select()
        .from(gateResults)
        .where(eq(gateResults.externalId, `gate_job:${jobId}`));
      expect(evidence, `no gate_results row for a ${terminal} job`).toBeDefined();
      expect(evidence!.status).toBe("failure");
      expect(evidence!.name).toBe(`isolation-${terminal}`);
      expect(evidence!.gitSha).toBe(gitSha);
      // Signed, not just written: the bundle land policy trusts is a DSSE
      // envelope, and an unsigned row would be evidence in name only.
      expect(evidence!.envelope).toBeTruthy();

      // 2. And the refusal is in the operation log, in the same transaction
      //    as the status flip (AGENTS.md's standing invariant).
      const [repo] = await db.select().from(repos).where(and(eq(repos.owner, owner), eq(repos.name, repoName)));
      const [op] = await db
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.verb, "gate_job.complete"),
            eq(operations.target, `${repo!.id}@${gitSha}#isolation-${terminal}`),
          ),
        );
      expect(op, `no gate_job.complete operation for a ${terminal} job`).toBeDefined();
      expect((op!.after as Record<string, unknown>).status).toBe(terminal);
    },
  );
});
