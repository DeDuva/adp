import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, count, eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { identities, gateJobs, gateResults, operations } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerGateJobRoutes } from "../src/http-rest/gate-jobs.js";

// A signer whose first signature attempt dies — standing in for any crash
// or fault between "the job flipped terminal" and "the evidence row
// committed". Before #95 those were two transactions, so this fault left a
// terminal job with no gate_results row and no way to re-drive it
// (complete refuses non-running jobs): a permanently gates_green-blocked
// commit. With one transaction, the same fault rolls everything back and
// the runner's ordinary retry produces both records.
class FaultOnceSigner extends Signer {
  private faulted = false;
  override signRaw(message: Uint8Array): Uint8Array {
    if (!this.faulted) {
      this.faulted = true;
      throw new Error("injected signer fault");
    }
    return super.signRaw(message);
  }
}

describe.skipIf(skipWithoutDb)("#95: gate-job completion and its evidence are one transaction", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let writeToken: string;
  let runnerToken: string;
  let runnerId: string;
  const owner = `atomic-owner-${Date.now()}`;

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

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-atomic-git-"));
    const gitBackend = new GitBackend(gitRoot);

    app = Fastify({ logger: false });
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerGateJobRoutes(
      app,
      db,
      gitBackend,
      new FaultOnceSigner("e2e-atomic-signing-key"),
      "https://adp.example.com",
      "e2e-test-credential-key",
    );

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [writer] = await db.insert(identities).values({ kind: "human", principal: `atomic-writer-${Date.now()}` }).returning();
    writeToken = await mintToken(db, writer!.id, ["repo:write"]);
    await grantOwner(db, writer!.id, owner);
    const [runner] = await db.insert(identities).values({ kind: "agent", principal: `atomic-runner-${Date.now()}` }).returning();
    runnerId = runner!.id;
    runnerToken = await mintToken(db, runner!.id, ["runner"]);

    await api(`/api/v3/repos/${owner}`, writeToken, { method: "POST", body: JSON.stringify({ name: "target" }) });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("a fault during the evidence write rolls the completion back, and the retry produces both records", async () => {
    const enqueued = await api(`/api/adp/repos/${owner}/target/gate-jobs`, writeToken, {
      method: "POST",
      body: JSON.stringify({ git_sha: "e".repeat(40), name: "atomic", image: "busybox:1", command: "true" }),
    });
    expect(enqueued.status).toBe(201);
    const jobId = enqueued.body!.id as string;

    // Claim toward our own job, holding-and-releasing what the shared queue
    // hands us on the way (the suite-wide etiquette every gate-job file uses).
    const held: string[] = [];
    let claimed = false;
    try {
      for (let i = 0; i < 100 && !claimed; i++) {
        const [row] = await db.select().from(gateJobs).where(eq(gateJobs.id, jobId));
        if (row!.status === "running" && row!.claimedByIdentityId === runnerId) {
          claimed = true;
          break;
        }
        if (row!.status === "running") {
          await db
            .update(gateJobs)
            .set({ status: "queued", claimedBy: null, claimedByIdentityId: null, startedAt: null, leaseExpiresAt: null })
            .where(and(eq(gateJobs.id, jobId), eq(gateJobs.status, "running")));
        }
        const res = await api("/api/adp/gate-jobs/claim", runnerToken, {
          method: "POST",
          body: JSON.stringify({ claimed_by: "atomic-runner" }),
        });
        if (res.status === 200 && res.body!.id === jobId) claimed = true;
        else if (res.status === 200) held.push(res.body!.id as string);
        else await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      for (const id of held) {
        await db
          .update(gateJobs)
          .set({ status: "queued", claimedBy: null, claimedByIdentityId: null, startedAt: null, leaseExpiresAt: null })
          .where(and(eq(gateJobs.id, id), eq(gateJobs.status, "running"), eq(gateJobs.claimedByIdentityId, runnerId)));
      }
    }
    expect(claimed).toBe(true);

    // First completion attempt: the signer faults inside the transaction.
    const faulted = await api(`/api/adp/gate-jobs/${jobId}/complete`, runnerToken, {
      method: "POST",
      body: JSON.stringify({ status: "succeeded", exit_code: 0 }),
    });
    expect(faulted.status).toBe(500);

    // Nothing committed: the job is still running (and still ours), there
    // is no evidence row, and no gate_job.complete operation.
    const [after] = await db.select().from(gateJobs).where(eq(gateJobs.id, jobId));
    expect(after!.status).toBe("running");
    expect(after!.claimedByIdentityId).toBe(runnerId);
    const [evidence] = await db
      .select({ n: count() })
      .from(gateResults)
      .where(eq(gateResults.externalId, `gate_job:${jobId}`));
    expect(evidence!.n).toBe(0);
    const [completeOps] = await db
      .select({ n: count() })
      .from(operations)
      .where(and(eq(operations.verb, "gate_job.complete"), eq(operations.repoId, after!.repoId)));
    expect(completeOps!.n).toBe(0);

    // The runner's ordinary retry — no psql, no requeue — now lands both.
    const retried = await api(`/api/adp/gate-jobs/${jobId}/complete`, runnerToken, {
      method: "POST",
      body: JSON.stringify({ status: "succeeded", exit_code: 0 }),
    });
    expect(retried.status).toBe(200);
    const [final] = await db.select().from(gateJobs).where(eq(gateJobs.id, jobId));
    expect(final!.status).toBe("succeeded");
    const [evidenceAfter] = await db
      .select({ n: count() })
      .from(gateResults)
      .where(eq(gateResults.externalId, `gate_job:${jobId}`));
    expect(evidenceAfter!.n).toBe(1);
  });
});
