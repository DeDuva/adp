import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type Db } from "../src/db/client.js";
import { identities, operations, orgMemberships, orgs, repos } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { mintToken } from "../src/auth/tokens.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerAuditLogRoutes } from "../src/http-rest/audit-log.js";
import { registerOrgRoutes } from "../src/http-rest/orgs.js";
import { registerOperationRoutes } from "../src/http-rest/operations.js";

// M4-3: the audit-log export, proven
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
    return { status: res.status, text, cursor: res.headers.get("adp-next-cursor") };
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
    registerOrgRoutes(app, db, gitBackend, []);
    // Exit criterion 4 reconciles the export against what adp_history_query /
    // adp_op_log return; both MCP tools are thin proxies over this route
    // (src/mcp/server.ts), so this is the surface the criterion names.
    registerOperationRoutes(app, db, gitBackend);

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

  // #147 replaced `repo_id IN (…) OR org_id = …` — which no index can serve —
  // with a LATERAL that gives each of the org's repos its own indexed,
  // limited scan, unioned with the org-level branch. The risk of that shape is
  // an operation losing its way into the export, and there are two ways in, so
  // this asserts both arrive and that filters are applied *inside* each branch
  // rather than after the merge.
  it("finds both repo-scoped and org-level operations, with filters applied per branch", async () => {
    const [filterActor] = await db
      .insert(identities)
      .values({ kind: "agent", principal: `audit-branch-${Date.now()}` })
      .returning();

    // A repo-scoped operation, deliberately old, behind a wall of newer rows
    // in the same repo. A branch that took its newest N and filtered
    // afterwards would miss it — which is the bug the per-branch filter
    // exists to prevent.
    // Scoped to *this* org's repos — the suite shares a database with every
    // other e2e file, so "any repo.create operation" is any test's repo.
    const [orgRepo] = await db.select({ id: repos.id }).from(repos).where(eq(repos.orgId, orgId)).limit(1);
    const someRepoId = orgRepo!.id;
    await db.insert(operations).values({
      repoId: someRepoId,
      actorId: filterActor!.id,
      verb: "audit.branch.repo",
      target: "buried",
      createdAt: new Date(Date.now() - 86_400_000),
    });
    await db.insert(operations).values(
      Array.from({ length: 40 }, (_, i) => ({
        repoId: someRepoId,
        actorId: filterActor!.id,
        verb: "audit.branch.noise",
        target: `noise-${i}`,
      })),
    );

    // And an org-level one, with no repo at all.
    await db.insert(operations).values({
      repoId: null,
      orgId,
      actorId: filterActor!.id,
      verb: "audit.branch.org",
      target: "org-level",
    });

    const both = await api(`/api/adp/orgs/${orgId}/audit-log?actor=${filterActor!.id}&limit=1000`, orgToken);
    const verbs = both.text.trim().split("\n").map((l) => (JSON.parse(l) as { verb: string }).verb);
    expect(verbs).toContain("audit.branch.repo");
    expect(verbs).toContain("audit.branch.org");

    // The buried row survives a narrow filter and a small page, which it only
    // can if the verb predicate is inside the LATERAL rather than outside it.
    const narrow = await api(`/api/adp/orgs/${orgId}/audit-log?verb=audit.branch.repo&limit=5`, orgToken);
    const found = narrow.text.trim().split("\n").map((l) => JSON.parse(l) as { target: string });
    expect(found).toHaveLength(1);
    expect(found[0]!.target).toBe("buried");
  });

  // The export's page size is its own; `since`/`until` was the only way past
  // it, and that is lossy across rows sharing a timestamp — which operations
  // recorded in one transaction do.
  it("pages with a keyset cursor, without repeating or skipping a row", async () => {
    // Seeded here rather than relying on what earlier tests happened to
    // leave behind — and seeded with **one shared timestamp**, because that
    // is the case the cursor exists for. Operations written in a single
    // transaction share `created_at` to the microsecond, so paging on the
    // timestamp alone either repeats them or skips them; only the (created_at,
    // id) pair is a total order.
    const sharedInstant = new Date();
    const [seedActor] = await db
      .insert(identities)
      .values({ kind: "agent", principal: `audit-pager-${Date.now()}` })
      .returning();
    await db.insert(operations).values(
      Array.from({ length: 7 }, (_, i) => ({
        repoId: null,
        orgId,
        actorId: seedActor!.id,
        verb: "audit.pager.probe",
        target: `probe-${i}`,
        createdAt: sharedInstant,
      })),
    );

    const all = await api(`/api/adp/orgs/${orgId}/audit-log?verb=audit.pager.probe&limit=1000`, orgToken);
    const everything = all.text.trim().split("\n").map((l) => (JSON.parse(l) as { id: string }).id);
    expect(everything).toHaveLength(7);

    const paged: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page++) {
      const qs: string = `/api/adp/orgs/${orgId}/audit-log?verb=audit.pager.probe&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await api(qs, orgToken);
      const ids = res.text.trim() ? res.text.trim().split("\n").map((l) => (JSON.parse(l) as { id: string }).id) : [];
      paged.push(...ids);
      cursor = res.cursor;
      if (!cursor) break;
    }

    // Same rows, same order, no duplicates — the three ways keyset paging
    // goes wrong.
    expect(paged).toEqual(everything);
    expect(new Set(paged).size).toBe(paged.length);
  });

  // #97: org administration writes are audited AND exported. The quota
  // ceilings used to be settable only through an unaudited psql UPDATE, and
  // the kill-switch op — repoId null, org nothing — was invisible to this
  // very export. Both halves in one flow: PATCH through the real route,
  // then read the same org's export and find the org-level rows.
  it("PATCHed org quotas and kill switch appear in the org's own audit export", async () => {
    const [orgAdmin] = await db
      .insert(identities)
      .values({ kind: "human", principal: `audit-org-admin-${Date.now()}` })
      .returning();
    await db.insert(orgMemberships).values({ orgId, identityId: orgAdmin!.id, role: "admin" });
    const orgAdminToken = await mintToken(db, orgAdmin!.id, ["admin"], { orgId });

    const patched = await fetch(`http://127.0.0.1:${port}/api/adp/orgs/${orgId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${orgAdminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kill_switch: true, max_repos: 7, max_concurrent_gate_jobs: 2 }),
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ kill_switch: true, max_repos: 7, max_concurrent_gate_jobs: 2 });

    const exportRes = await api(`/api/adp/orgs/${orgId}/audit-log`, orgToken);
    const verbs = exportRes.text
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { verb: string }).verb);
    expect(verbs).toContain("org.kill_switch");
    expect(verbs).toContain("org.quota_update");

    const quotaRow = exportRes.text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { verb: string; after?: { max_repos?: number } })
      .find((r) => r.verb === "org.quota_update");
    expect(quotaRow?.after?.max_repos).toBe(7);

    // Leave the org usable for any test after us.
    await fetch(`http://127.0.0.1:${port}/api/adp/orgs/${orgId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${orgAdminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kill_switch: false, max_repos: null, max_concurrent_gate_jobs: null }),
    });
  });
  // ── M4 exit criterion 4 ──────────────────────────────────────────────────
  //
  // "The audit-log export reconciles with the operation log — every row in an
  // export matches a row adp_history_query/adp_op_log would return for the
  // same filter, by construction (same table), proven by a test rather than
  // asserted by the description."
  //
  // What was here before this test asserted row *counts* — that the export
  // returns exactly the two repo.create rows the org has. That is a weaker
  // claim than the criterion's, and weaker in the way that matters: two
  // queries can return the same number of rows and disagree about which rows,
  // or agree on which rows and disagree about their contents. So this compares
  // the two views field for field, and in both directions.
  //
  // The comparison is by id-keyed set, not by ordered list, deliberately.
  // Both sides order by created_at DESC, and operations written inside one
  // transaction share a timestamp — so their relative order is not defined by
  // anything, and asserting on it would produce a test that fails on timing
  // rather than on truth.
  //
  // One asymmetry is real and is part of the criterion rather than a failure
  // of it: the export is org-scoped and includes org-LEVEL operations
  // (org.kill_switch, org.quota_update — repo_id null, org_id set, #97),
  // while adp_history_query is repo-scoped and structurally cannot return
  // them. So the identity being proven is:
  //
  //     export(org, filter)  ==  ⋃ oplog(repo, filter) over the org's repos
  //                              ∪  org-level rows(org, filter)
  //
  // and it is asserted in that shape rather than glossed.

  interface ExportRow {
    id: string;
    repo_id: string | null;
    actor_id: string;
    verb: string;
    target: string;
    before: unknown;
    after: unknown;
    parent_op: string | null;
    created_at: string;
  }

  // The export carries repo_id (it spans repos); the repo-scoped op log does
  // not (the route path already said which repo). Everything else is the same
  // projection of the same row, and is what gets compared.
  const SHARED_FIELDS = ["id", "actor_id", "verb", "target", "before", "after", "parent_op", "created_at"] as const;
  const shared = (row: Record<string, unknown>) =>
    Object.fromEntries(SHARED_FIELDS.map((f) => [f, row[f] ?? null]));

  async function reconcile(filter: string) {
    const limit = 200; // the op-log route's maximum; the export's ceiling is higher

    const exportRes = await api(`/api/adp/orgs/${orgId}/audit-log?limit=${limit}${filter}`, orgToken);
    expect(exportRes.status).toBe(200);
    const exported: ExportRow[] = exportRes.text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ExportRow);

    const oplog: Record<string, unknown>[] = [];
    for (const name of ["repo-a", "repo-b"]) {
      const res = await api(`/api/adp/repos/${orgName}/${name}/operations?limit=${limit}${filter}`, orgToken);
      expect(res.status).toBe(200);
      const rows = JSON.parse(res.text) as Record<string, unknown>[];
      // A truncated side would make the comparison below pass by accident on
      // whatever happened to survive the cut. Neither side may be at its
      // limit for this reconciliation to mean anything.
      expect(rows.length).toBeLessThan(limit);
      oplog.push(...rows);
    }
    expect(exported.length).toBeLessThan(limit);

    return { exported, oplog };
  }

  // Writes one org-level operation by a *second* actor, and returns that
  // actor. Called by each test that needs it rather than left as a side
  // effect of whichever test happens to run first: a reconciliation over a
  // fixture with one verb and one actor cannot distinguish a filter that
  // works from a filter that is ignored, and a test that depends on an
  // earlier test for its data passes vacuously when run alone (`-t`) — which
  // is this repo's "a skipped test must never look like a passing one", one
  // level down.
  async function writeOrgLevelOperation(seed: string): Promise<string> {
    const [admin] = await db
      .insert(identities)
      .values({ kind: "human", principal: `audit-${seed}-${Date.now()}` })
      .returning();
    await db.insert(orgMemberships).values({ orgId, identityId: admin!.id, role: "admin" });
    const adminToken = await mintToken(db, admin!.id, ["admin"], { orgId });
    const patched = await fetch(`http://127.0.0.1:${port}/api/adp/orgs/${orgId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ max_concurrent_workspaces: 3 }),
    });
    expect(patched.status).toBe(200);
    return admin!.id;
  }

  it("reconciles every export row against the op-log query for the same filter, in both directions", async () => {
    // Exercises the repo_id-null half of the identity rather than assuming it.
    await writeOrgLevelOperation("reconcile-admin");

    const { exported, oplog } = await reconcile("");

    // Vacuity guards. Every assertion below is over a set, and a set can be
    // empty — an export returning nothing would "reconcile" with an op log
    // returning nothing and prove precisely nothing.
    const repoScoped = exported.filter((r) => r.repo_id !== null);
    const orgLevel = exported.filter((r) => r.repo_id === null);
    expect(repoScoped.length).toBeGreaterThan(0);
    expect(orgLevel.length).toBeGreaterThan(0);
    expect(oplog.length).toBeGreaterThan(0);

    const oplogById = new Map(oplog.map((r) => [r.id as string, r]));

    // Direction 1: every repo-scoped export row is in the op log, and the two
    // copies agree on every field they share — not merely on the id.
    for (const row of repoScoped) {
      const match = oplogById.get(row.id);
      expect(match, `export row ${row.id} (${row.verb}) is absent from the op log`).toBeDefined();
      expect(shared(row as unknown as Record<string, unknown>)).toEqual(shared(match!));
    }

    // Direction 2: and nothing the op log returns is missing from the export.
    // Without this the export could silently drop rows and still pass.
    const exportedById = new Map(exported.map((r) => [r.id, r]));
    for (const row of oplog) {
      expect(exportedById.has(row.id as string), `op-log row ${row.id} (${row.verb}) is absent from the export`).toBe(true);
    }

    // The asymmetry, asserted rather than glossed: org-level rows are exactly
    // the ones no repo-scoped query can return, because they have no repo.
    for (const row of orgLevel) {
      expect(oplogById.has(row.id)).toBe(false);
    }
    expect(orgLevel.map((r) => r.verb)).toContain("org.quota_update");
  });

  // "For the same filter" is the half of the criterion an unfiltered
  // comparison cannot prove: two views can agree on the whole table and still
  // apply the same filter differently — a WHERE clause on one side and none on
  // the other reconciles perfectly until someone filters.
  it("reconciles under a verb filter and an actor filter, not only unfiltered", async () => {
    await writeOrgLevelOperation("filter-admin");

    // A filter is only under test if there is something for it to exclude.
    // Without these two guards this test passes on a fixture where every row
    // already has the verb and actor being filtered for — which is exactly
    // what it looks like when run in isolation.
    const all = await reconcile("");
    expect(new Set(all.exported.map((r) => r.verb)).size).toBeGreaterThan(1);
    expect(new Set(all.exported.map((r) => r.actor_id)).size).toBeGreaterThan(1);

    const byVerb = await reconcile("&verb=repo.create");
    expect(byVerb.exported.length).toBeLessThan(all.exported.length);
    expect(byVerb.exported.length).toBeGreaterThan(0);
    expect(byVerb.exported.every((r) => r.verb === "repo.create")).toBe(true);
    expect(byVerb.oplog.every((r) => r.verb === "repo.create")).toBe(true);
    expect(new Set(byVerb.oplog.map((r) => r.id))).toEqual(
      new Set(byVerb.exported.filter((r) => r.repo_id !== null).map((r) => r.id)),
    );

    const actorId = byVerb.exported[0]!.actor_id;
    const byActor = await reconcile(`&actor=${actorId}`);
    expect(byActor.exported.length).toBeGreaterThan(0);
    expect(byActor.exported.every((r) => r.actor_id === actorId)).toBe(true);
    expect(new Set(byActor.oplog.map((r) => r.id))).toEqual(
      new Set(byActor.exported.filter((r) => r.repo_id !== null).map((r) => r.id)),
    );
  });
});
