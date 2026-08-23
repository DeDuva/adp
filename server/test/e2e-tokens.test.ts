import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { desc, eq, isNull, and } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { identities, orgs, operations, gateJobs } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerTokenRoutes } from "../src/http-rest/tokens.js";
import { registerGateJobRoutes } from "../src/http-rest/gate-jobs.js";

// #90: the audit's named proof, both
// directions — an admin token is REFUSED on the gate-job routes (admin no
// longer satisfies runner), and a runner token minted through the new REST
// route is accepted on them. Plus the mint route's own boundaries: admin
// cannot be minted here, non-admins cannot mint at all, and the minted
// token inherits the minting token's org.
describe.skipIf(skipWithoutDb)("#90: token minting and the runner scope boundary", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let adminToken: string;
  let adminIdentityId: string;
  const owner = `tok-owner-${Date.now()}`;

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

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-tokens-git-"));
    const gitBackend = new GitBackend(gitRoot);
    const signer = new Signer("e2e-tokens-signing-key");

    app = Fastify({ logger: false });
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerTokenRoutes(app, db);
    registerGateJobRoutes(app, db, gitBackend, signer, "https://adp.example.com", "e2e-test-credential-key");

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    // The same shape bootstrap.ts mints — the token a real deployment's
    // operator starts from.
    const [admin] = await db.insert(identities).values({ kind: "human", principal: `tok-admin-${Date.now()}` }).returning();
    adminIdentityId = admin!.id;
    adminToken = await mintToken(db, admin!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, admin!.id, owner);

    await api(`/api/v3/repos/${owner}`, adminToken, { method: "POST", body: JSON.stringify({ name: "target" }) });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("refuses to mint for a non-admin token", async () => {
    const [peon] = await db.insert(identities).values({ kind: "human", principal: `tok-peon-${Date.now()}` }).returning();
    const writeToken = await mintToken(db, peon!.id, ["repo:write"]);
    const res = await api("/api/adp/tokens", writeToken, {
      method: "POST",
      body: JSON.stringify({ principal: "some-runner", scopes: ["runner"] }),
    });
    expect(res.status).toBe(403);
  });

  it("cannot mint an admin token — the scope set is bounded", async () => {
    const res = await api("/api/adp/tokens", adminToken, {
      method: "POST",
      body: JSON.stringify({ principal: "escalator", scopes: ["admin"] }),
    });
    expect(res.status).toBe(422);
  });

  it("admin is refused on the gate-job plane; a REST-minted runner token is accepted (the §P0-4 proof)", async () => {
    // The refusals need no job to exist: requireScope("runner") turns the
    // admin token away at the door on all three routes.
    for (const attempt of [
      api("/api/adp/gate-jobs/claim", adminToken, { method: "POST", body: JSON.stringify({ claimed_by: "admin-as-runner" }) }),
      api(`/api/adp/gate-jobs/00000000-0000-0000-0000-000000000000/checkout`, adminToken),
      api(`/api/adp/gate-jobs/00000000-0000-0000-0000-000000000000/complete`, adminToken, {
        method: "POST",
        body: JSON.stringify({ status: "succeeded" }),
      }),
    ]) {
      expect((await attempt).status).toBe(403);
    }

    const minted = await api("/api/adp/tokens", adminToken, {
      method: "POST",
      body: JSON.stringify({ principal: `tok-runner-${Date.now()}`, scopes: ["runner"] }),
    });
    expect(minted.status).toBe(201);
    expect(minted.body).toMatchObject({ scopes: ["runner"], org_id: null });
    const runnerToken = minted.body!.token as string;
    const runnerIdentityId = minted.body!.identity_id as string;

    // The minted token actually works the queue: enqueue a job and drive
    // claim with it until it holds this job (another e2e file's polling can
    // legitimately win any given claim call — loop past those, never touch
    // them), then complete it. Ownership (#88) makes the completion also
    // prove the claim was recorded under the minted token's own identity.
    const enqueued = await api(`/api/adp/repos/${owner}/target/gate-jobs`, adminToken, {
      method: "POST",
      body: JSON.stringify({ git_sha: "b".repeat(40), name: "minted", image: "node:22", command: "true" }),
    });
    expect(enqueued.status).toBe(201);
    const jobId = enqueued.body!.id as string;

    // The shared-queue hunt etiquette every gate-job e2e file uses (see
    // e2e-gate-jobs.test.ts's claimJobId for the reasoning): force-requeue
    // our own target out of a foreign claimant's hands, hold what our
    // claims pop, hand the held jobs back — conditionally — when done.
    let claimed: Record<string, unknown> | null = null;
    const held: string[] = [];
    try {
      for (let i = 0; i < 100 && !claimed; i++) {
        const [target] = await db.select().from(gateJobs).where(eq(gateJobs.id, jobId));
        if (target!.status === "running" && target!.claimedByIdentityId !== runnerIdentityId) {
          await db
            .update(gateJobs)
            .set({ status: "queued", claimedBy: null, claimedByIdentityId: null, startedAt: null, leaseExpiresAt: null })
            .where(and(eq(gateJobs.id, jobId), eq(gateJobs.status, "running")));
        }
        const res = await api("/api/adp/gate-jobs/claim", runnerToken, {
          method: "POST",
          body: JSON.stringify({ claimed_by: "rest-minted-runner" }),
        });
        if (res.status === 200 && res.body!.id === jobId) claimed = res.body;
        else if (res.status === 200) held.push(res.body!.id as string);
        else await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      for (const heldId of held) {
        await db
          .update(gateJobs)
          .set({ status: "queued", claimedBy: null, claimedByIdentityId: null, startedAt: null, leaseExpiresAt: null })
          .where(
            and(eq(gateJobs.id, heldId), eq(gateJobs.status, "running"), eq(gateJobs.claimedByIdentityId, runnerIdentityId)),
          );
      }
    }
    expect(claimed).not.toBeNull();

    const completed = await api(`/api/adp/gate-jobs/${jobId}/complete`, runnerToken, {
      method: "POST",
      body: JSON.stringify({ status: "succeeded", exit_code: 0 }),
    });
    expect(completed.status).toBe(200);
  });

  it("a minted token inherits the minting token's org — there is no parameter that reaches another", async () => {
    const [org] = await db.insert(orgs).values({ name: `tok-org-${Date.now()}` }).returning();
    const orgAdminToken = await mintToken(db, adminIdentityId, ["admin"], { orgId: org!.id });

    const res = await api("/api/adp/tokens", orgAdminToken, {
      method: "POST",
      body: JSON.stringify({ principal: `tok-org-runner-${Date.now()}`, scopes: ["runner"] }),
    });
    expect(res.status).toBe(201);
    expect(res.body!.org_id).toBe(org!.id);
  });

  it("records a token.mint operation naming actor, principal, and scopes — never the token", async () => {
    const principal = `tok-audited-${Date.now()}`;
    const minted = await api("/api/adp/tokens", adminToken, {
      method: "POST",
      body: JSON.stringify({ principal, scopes: ["repo:read"] }),
    });
    expect(minted.status).toBe(201);

    const [op] = await db
      .select()
      .from(operations)
      .where(and(eq(operations.verb, "token.mint"), eq(operations.target, principal), isNull(operations.repoId)))
      .orderBy(desc(operations.createdAt))
      .limit(1);
    expect(op).toBeDefined();
    expect(op!.actorId).toBe(adminIdentityId);
    expect(JSON.stringify(op!.after)).not.toContain(minted.body!.token as string);
  });
});
