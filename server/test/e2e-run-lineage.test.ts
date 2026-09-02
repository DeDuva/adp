import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { skipWithoutDb } from "./require-db.js";
import { identities, operations, runs } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerIssueRoutes } from "../src/http-rest/issues.js";
import { registerRunRoutes } from "../src/http-rest/runs.js";
import { findRepo } from "../src/core/repos-lookup.js";

// #240 — reimplementation and continuation are different facts.
//
// `sessions.resumedFromSessionId` already models "Codex continued Claude's
// unfinished work", and #151 built the cross-harness resume on it. What it
// cannot model is "GPT-8 independently reimplemented GPT-6's bad change": that
// is not a continuation, it is a second attempt at the same intent that
// deliberately started over. Only the first had a column, so the second was
// recorded as a resume — a lie about the trajectory — or as nothing, which is a
// lie about the history.
describe.skipIf(skipWithoutDb)("#240: run lineage", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  let repoId: string;
  let intentId: string;
  const owner = `run-lineage-owner-${Date.now()}`;
  const name = "widget";

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-run-lineage-"));
    const gitBackend = new GitBackend(gitRoot);
    const signer = new Signer("e2e-run-lineage-key");

    app = Fastify({ logger: false });
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerIssueRoutes(app, db);
    registerRunRoutes(app, db, gitBackend, signer, "https://adp.example.com");

    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `run-lineage-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);

    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name }) });
    repoId = (await findRepo(db, owner, name))!.id;
    const issue = await api(`/api/v3/repos/${owner}/${name}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: "reimplement me" }),
    });
    intentId = (issue.body as { intent_id: string }).intent_id;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  async function api(pathAndQuery: string, init: RequestInit = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }

  function openRun(body: Record<string, unknown>) {
    return api(`/api/adp/repos/${owner}/${name}/runs`, {
      method: "POST",
      body: JSON.stringify({ intent_id: intentId, orchestrator: "squad", ...body }),
    });
  }

  it("records a run that follows nothing as following nothing", async () => {
    const first = await openRun({ external_ref: `plain-${Date.now()}` });
    expect(first.status).toBe(201);
    // Present and null rather than absent: a client can tell "no lineage" from
    // "this server is too old to say".
    expect(first.body).toMatchObject({ parent_run: null, parent_relationship: null });
  });

  // The fact that had no column. A reimplementation is not a resume, and the
  // difference is what 2-4 has to be able to price: an independent second
  // attempt is evidence in a way a continuation is not.
  it("tells a reimplementation from a continuation", async () => {
    const parent = await openRun({ external_ref: `parent-${Date.now()}` });
    const parentId = (parent.body as { id: string }).id;

    const reimplemented = await openRun({
      external_ref: `reimpl-${Date.now()}`,
      parent_run: parentId,
      relationship: "reimplement",
    });
    expect(reimplemented.status).toBe(201);
    expect(reimplemented.body).toMatchObject({ parent_run: parentId, parent_relationship: "reimplement" });

    const continued = await openRun({
      external_ref: `cont-${Date.now()}`,
      parent_run: parentId,
      relationship: "continue",
    });
    expect(continued.body).toMatchObject({ parent_run: parentId, parent_relationship: "continue" });

    // Both point at the same parent, and the record says which is which — which
    // is the whole of the item.
    const children = await db.select().from(runs).where(eq(runs.parentRunId, parentId));
    expect(children.map((r) => r.parentRelationship).sort()).toEqual(["continue", "reimplement"]);
  });

  it("records the lineage in the operation log, not only on the row", async () => {
    const parent = await openRun({ external_ref: `op-parent-${Date.now()}` });
    const parentId = (parent.body as { id: string }).id;
    const child = await openRun({
      external_ref: `op-child-${Date.now()}`,
      parent_run: parentId,
      relationship: "supersede",
    });

    const [op] = await db
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.repoId, repoId),
          eq(operations.target, `${owner}/${name}@run:${(child.body as { id: string }).id}`),
        ),
      );
    expect(op!.after).toMatchObject({ parentRunId: parentId, parentRelationship: "supersede" });
  });

  // Half a lineage is worse than none. A parent with no relationship cannot be
  // interpreted; a relationship with no parent is a claim about a run nobody
  // named. A run with no lineage at all is ordinary and complete.
  it("refuses half a lineage, in either direction", async () => {
    const parent = await openRun({ external_ref: `half-${Date.now()}` });
    const parentId = (parent.body as { id: string }).id;

    const noRelationship = await openRun({ external_ref: `half-a-${Date.now()}`, parent_run: parentId });
    expect(noRelationship.status).toBe(422);
    expect(noRelationship.body!.message).toContain("both ends");

    const noParent = await openRun({ external_ref: `half-b-${Date.now()}`, relationship: "retry" });
    expect(noParent.status).toBe(422);
  });

  it("refuses a relationship outside the four", async () => {
    const parent = await openRun({ external_ref: `enum-${Date.now()}` });
    const bad = await openRun({
      external_ref: `enum-bad-${Date.now()}`,
      parent_run: (parent.body as { id: string }).id,
      relationship: "inspired-by",
    });
    expect(bad.status).toBe(422);
  });

  // A run id is caller input, and lineage that crossed repositories would let
  // one repository's history name another's.
  it("refuses a parent in another repository", async () => {
    const otherName = "other-widget";
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: otherName }) });
    const otherIssue = await api(`/api/v3/repos/${owner}/${otherName}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: "elsewhere" }),
    });
    const elsewhere = await api(`/api/adp/repos/${owner}/${otherName}/runs`, {
      method: "POST",
      body: JSON.stringify({
        intent_id: (otherIssue.body as { intent_id: string }).intent_id,
        orchestrator: "squad",
        external_ref: `elsewhere-${Date.now()}`,
      }),
    });

    const refused = await openRun({
      external_ref: `cross-${Date.now()}`,
      parent_run: (elsewhere.body as { id: string }).id,
      relationship: "reimplement",
    });
    expect(refused.status).toBe(422);
    expect(refused.body!.message).toContain("not found in this repository");
  });
});
