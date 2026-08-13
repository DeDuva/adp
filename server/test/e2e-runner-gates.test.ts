import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { identities, gateJobs } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerHookRoutes } from "../src/http-git/hooks.js";
import { registerGateJobRoutes } from "../src/http-rest/gate-jobs.js";
import { registerGateRoutes } from "../src/http-rest/gates.js";

const execFileAsync = promisify(execFile);

// M4-9c (docs/m4-readiness-review.md §4): adp.yaml's `runner.gates` end to
// end — a real push whose adp.yaml names an ADP-run gate auto-enqueues a
// gate_jobs row (http-git/hooks.ts); a stub runner (same substrate M4-9a's
// own tests use, real HTTP rather than a real Docker daemon — that half is
// runner/src/docker.test.ts's job) claims it, fetches a real checkout
// tarball of the pushed tree (core/git-backend.ts's archiveTar, proven
// against a real repo, not a fixture), and completing it produces a real
// signed `gate_results` row — indistinguishable from a self-reported one to
// everything downstream (core/gate-results.ts).
describe.skipIf(skipWithoutDb)("M4-9c: adp.yaml-driven gate jobs", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let writeToken: string;
  let runnerToken: string;
  let runnerIdentityId: string;
  const owner = `runner-gates-owner-${Date.now()}`;

  async function api(pathAndQuery: string, token: string, init: RequestInit = {}) {
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

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-runner-gates-git-"));
    const gitBackend = new GitBackend(gitRoot);
    const signer = new Signer("e2e-runner-gates-signing-key");

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerHookRoutes(app, db, gitBackend, signer, "e2e-test-credential-key");
    registerGateJobRoutes(app, db, gitBackend, signer, "https://adp.example.com", "e2e-test-credential-key");
    registerGateRoutes(app, db, signer, "https://adp.example.com", "e2e-test-credential-key");
    registerGitHttpRoutes(app, gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;
    gitBackend.setInternalUrl(`http://127.0.0.1:${port}`);

    const [writer] = await db.insert(identities).values({ kind: "human", principal: `rg-writer-${Date.now()}` }).returning();
    writeToken = await mintToken(db, writer!.id, ["repo:read", "repo:write"]);

    const [runner] = await db.insert(identities).values({ kind: "agent", principal: `rg-runner-${Date.now()}` }).returning();
    runnerIdentityId = runner!.id;
    runnerToken = await mintToken(db, runner!.id, ["runner"]);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("auto-enqueues from adp.yaml on push, and the full claim -> checkout -> complete cycle produces real signed evidence", async () => {
    const repoName = "widget";
    await api(`/api/v3/repos/${owner}`, writeToken, { method: "POST", body: JSON.stringify({ name: repoName }) });

    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-runner-gates-clone-"));
    const cloneUrl = `http://x-access-token:${writeToken}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await writeFile(
      path.join(cloneDir, "adp.yaml"),
      "runner:\n  image: busybox:1\n  setup: echo setting-up\n  gates:\n    - name: unit\n      run: cat marker.txt\n",
    );
    await writeFile(path.join(cloneDir, "marker.txt"), "hello-from-checkout");
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "add runner config"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    const sha = (await execFileAsync("git", ["rev-parse", "main"], { cwd: cloneDir })).stdout.trim();
    await rm(cloneDir, { recursive: true, force: true });

    // Push returns as soon as receive-pack's hooks finish, but post-receive's
    // own fetch back into this server fires after — same fixed wait
    // e2e-hooks.test.ts uses for the same reason.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const list = await api(`/api/adp/repos/${owner}/${repoName}/gate-jobs`, writeToken);
    const jobs = (list.body as { gate_jobs: { id: string; name: string; status: string; image: string; command: string }[] })
      .gate_jobs;
    const job = jobs.find((j) => j.name === "unit");
    // Not asserting status here: claim is instance-wide (M4-9a) and shared
    // across every e2e file vitest runs concurrently against this same
    // database, so by the time this checks, jobId may already be `running`
    // — claimed by another file's own claim polling, not this test's. What
    // this assertion actually verifies (adp.yaml's runner block was parsed
    // and turned into the right image/command) doesn't depend on status.
    expect(job).toMatchObject({ image: "busybox:1", command: "echo setting-up && cat marker.txt" });
    const jobId = job!.id;

    // Since #88, /checkout and /complete only serve the identity that
    // claimed the job — so this test must end up holding jobId's claim
    // *itself*, not merely observe that someone claimed it. Claim is still
    // instance-wide and raced by every other e2e file polling this same
    // shared database, and a job another file's identity claims is
    // unrecoverable to us until the #92 lease/reaper exists — so when that
    // happens, requeue the row directly in the DB (a manual stand-in for
    // that reaper, on a job this test itself enqueued and owns) and keep
    // claiming until our own identity wins it.
    for (let i = 0; i < 40; i++) {
      const [row] = await db
        .select({ status: gateJobs.status, claimedByIdentityId: gateJobs.claimedByIdentityId })
        .from(gateJobs)
        .where(eq(gateJobs.id, jobId));
      if (row!.status === "running" && row!.claimedByIdentityId === runnerIdentityId) break;
      if (row!.status === "running") {
        await db
          .update(gateJobs)
          .set({ status: "queued", claimedBy: null, claimedByIdentityId: null, startedAt: null })
          .where(eq(gateJobs.id, jobId));
      }
      await api("/api/adp/gate-jobs/claim", runnerToken, { method: "POST", body: JSON.stringify({ claimed_by: "stub-runner-1" }) });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // Real tar bytes, over a real socket, off the real bare repo — not a
    // fixture standing in for what archiveTar produces.
    const checkoutRes = await fetch(`http://127.0.0.1:${port}/api/adp/gate-jobs/${jobId}/checkout`, {
      headers: { Authorization: `Bearer ${runnerToken}` },
    });
    expect(checkoutRes.status).toBe(200);
    expect(checkoutRes.headers.get("content-type")).toBe("application/x-tar");
    const tarBuf = Buffer.from(await checkoutRes.arrayBuffer());

    const extractDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-runner-gates-extract-"));
    const tarPath = path.join(extractDir, "checkout.tar");
    await writeFile(tarPath, tarBuf);
    await execFileAsync("tar", ["-xf", tarPath], { cwd: extractDir });
    const marker = await readFile(path.join(extractDir, "marker.txt"), "utf8");
    expect(marker).toBe("hello-from-checkout");
    await rm(extractDir, { recursive: true, force: true });

    const completed = await api(`/api/adp/gate-jobs/${jobId}/complete`, runnerToken, {
      method: "POST",
      body: JSON.stringify({ status: "succeeded", exit_code: 0, logs: "hello-from-checkout\n" }),
    });
    expect(completed.status).toBe(200);

    // The checkout window closes once a job is no longer claimed — a runner
    // that already completed a job (or anyone else) cannot re-fetch its code
    // through this route afterward.
    const checkoutAfterComplete = await fetch(`http://127.0.0.1:${port}/api/adp/gate-jobs/${jobId}/checkout`, {
      headers: { Authorization: `Bearer ${runnerToken}` },
    });
    expect(checkoutAfterComplete.status).toBe(409);

    // The point of the whole slice: a completed gate job is real,
    // DSSE-signed evidence — the same kind gates.ts's self-report route
    // produces, readable through the same route.
    const gatesRes = await api(`/api/v3/repos/${owner}/${repoName}/commits/${sha}/gates`, writeToken);
    const gateList = gatesRes.body as { name: string; status: string; summary: string; envelope: { payloadType: string } }[];
    const unitGate = gateList.find((g) => g.name === "unit");
    expect(unitGate).toBeDefined();
    expect(unitGate!.status).toBe("success");
    expect(unitGate!.summary).toContain("succeeded");
    expect(unitGate!.envelope.payloadType).toBe("application/vnd.in-toto+json");
  }, 30_000);
});
