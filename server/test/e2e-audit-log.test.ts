import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type Db } from "../src/db/client.js";
import { identities, orgMemberships, orgs } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerAuditLogRoutes } from "../src/http-rest/audit-log.js";

// M4-3 (docs/m4-readiness-review.md §4): the audit-log export, proven
// through the real REST route — the first real consumer of requireOrgAccess
// (auth/plugin.ts, built in M4-1 with no route calling it yet).
describe.skipIf(skipWithoutDb)("M4-3: audit-log export", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let orgToken: string;
  let outsiderToken: string;
  let orgId: string;
  const orgName = `audit-org-${Date.now()}`;

  async function api(pathAndQuery: string, token: string) {
    const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    return { status: res.status, text };
  }

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-audit-log-git-"));
    const gitBackend = new GitBackend(gitRoot);

    app = Fastify({ logger: false });
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerAuditLogRoutes(app, db);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    // The org exists *before* the first repo is created under its name, so
    // M4-3's findOrCreateOrg (http-rest/repos.ts) finds this row rather than
    // creating a fresh, unrelated one — the two repos below land in the same
    // org this way.
    const [org] = await db.insert(orgs).values({ name: orgName }).returning();
    orgId = org!.id;

    const [member] = await db.insert(identities).values({ kind: "human", principal: `audit-member-${Date.now()}` }).returning();
    await db.insert(orgMemberships).values({ orgId, identityId: member!.id, role: "member" });
    orgToken = await mintToken(db, member!.id, ["repo:read", "repo:write"], { orgId });

    const [outsider] = await db.insert(identities).values({ kind: "human", principal: `audit-outsider-${Date.now()}` }).returning();
    outsiderToken = await mintToken(db, outsider!.id, ["repo:read", "repo:write"]); // no orgId at all

    // Two repos sharing one org — repo.create operations from both should
    // show up in one org-wide export.
    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${orgName}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${orgToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "repo-a" }),
    });
    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${orgName}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${orgToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "repo-b" }),
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("refuses a token not scoped to the org", async () => {
    const res = await api(`/api/adp/orgs/${orgId}/audit-log`, outsiderToken);
    expect(res.status).toBe(403);
  });

  it("exports repo.create operations from every repo in the org, as NDJSON by default", async () => {
    const res = await api(`/api/adp/orgs/${orgId}/audit-log`, orgToken);
    expect(res.status).toBe(200);
    const lines = res.text.trim().split("\n").map((l) => JSON.parse(l) as { verb: string; target: string });
    const creates = lines.filter((l) => l.verb === "repo.create");
    expect(creates.some((l) => l.target === `${orgName}/repo-a`)).toBe(true);
    expect(creates.some((l) => l.target === `${orgName}/repo-b`)).toBe(true);
  });

  it("filters by verb", async () => {
    const res = await api(`/api/adp/orgs/${orgId}/audit-log?verb=repo.create`, orgToken);
    const lines = res.text.trim().split("\n").map((l) => JSON.parse(l) as { verb: string });
    expect(lines.every((l) => l.verb === "repo.create")).toBe(true);
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it("exports as CSV on request, with a header row", async () => {
    const res = await api(`/api/adp/orgs/${orgId}/audit-log?format=csv`, orgToken);
    expect(res.status).toBe(200);
    const rows = res.text.trim().split("\n");
    expect(rows[0]).toBe("id,repo_id,actor_id,verb,target,created_at");
    expect(rows.length).toBeGreaterThan(1);
  });

  it("exports exactly the two repo.create rows this org has — no more, no fewer", async () => {
    const res = await api(`/api/adp/orgs/${orgId}/audit-log?verb=repo.create`, orgToken);
    const exported = res.text.trim().split("\n").map((l) => JSON.parse(l) as { id: string; target: string });
    expect(exported).toHaveLength(2);
    expect(new Set(exported.map((e) => e.target))).toEqual(new Set([`${orgName}/repo-a`, `${orgName}/repo-b`]));
  });
});
