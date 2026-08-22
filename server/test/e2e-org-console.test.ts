import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, desc, eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { identities, orgs, orgMemberships, repos, operations } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { repoAccessCheck } from "../src/core/repos-lookup.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerOrgRoutes } from "../src/http-rest/orgs.js";

const execFileAsync = promisify(execFile);

// M4-7: the org policy console's API (docs/m4-readiness-review.md §4).
//
// The interesting assertions here are the ones a mock could not make: the
// resolved policy is computed by reading a real policy.yaml out of a real
// policy repo and a real adp.yaml out of a real governed repo, over real git,
// and compared against what land policy would actually enforce. A test that
// stubbed the git reads would be asserting that this file's own arithmetic
// works, which is not the thing that can be wrong.
//
// Instance floor is deliberately non-empty (`gates_green`) — the console's
// whole job is showing three layers and which of them imposed what, and a
// test with an empty instance floor cannot tell "the union works" from "only
// the org layer is being read".
describe.skipIf(skipWithoutDb)("M4-7: org policy console", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let orgToken: string;
  let adminOrgToken: string;
  let unscopedToken: string;
  let otherOrgToken: string;
  let orgId: string;
  let otherOrgId: string;
  let adminIdentityId: string;
  const owner = `org-console-${Date.now()}`;

  async function api(pathAndQuery: string, init: RequestInit = {}, token = orgToken) {
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

  // A real repo with a real file on its default branch, pushed over the real
  // git wire — the same path a user's repo takes.
  async function createRepoWithFile(name: string, file: string, contents: string) {
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name }) }, adminOrgToken);

    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-org-console-"));
    const cloneUrl = `http://x-access-token:${adminOrgToken}@127.0.0.1:${port}/${owner}/${name}.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await writeFile(path.join(cloneDir, file), contents);
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", `add ${file}`], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    await rm(cloneDir, { recursive: true, force: true });

    const [row] = await db.select().from(repos).where(and(eq(repos.owner, owner), eq(repos.name, name)));
    return row!;
  }

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-org-console-git-"));
    const gitBackend = new GitBackend(gitRoot);

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);
    registerOrgRoutes(app, db, gitBackend, ["gates_green"]);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    // repos.ts find-or-creates one org per owner string (M4-3), so creating
    // the first repo under `owner` is what brings this org into existence —
    // the same way a real instance gets one.
    const [admin] = await db
      .insert(identities)
      .values({ kind: "human", principal: `org-console-admin-${Date.now()}` })
      .returning();
    adminIdentityId = admin!.id;
    const bootstrapToken = await mintToken(db, adminIdentityId, ["admin"]);
    // #91: the org is provisioned explicitly (through the real route — the
    // console's org is born the same way a real instance's now is), then the
    // first repo is created inside it.
    const orgRes = await fetch(`http://127.0.0.1:${port}/api/adp/orgs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bootstrapToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: owner }),
    });
    orgId = ((await orgRes.json()) as { id: string }).id;
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: "seed" }) }, bootstrapToken);
    const [seed] = await db.select().from(repos).where(and(eq(repos.owner, owner), eq(repos.name, "seed")));
    if (seed!.orgId !== orgId) throw new Error("seed repo did not attach to the provisioned org");

    const [other] = await db.insert(orgs).values({ name: `org-console-other-${Date.now()}` }).returning();
    otherOrgId = other!.id;

    // POST /api/adp/orgs already seeded adminIdentityId's membership in
    // `orgId`; only the second org's membership needs inserting by hand.
    await db.insert(orgMemberships).values({ orgId: otherOrgId, identityId: adminIdentityId, role: "member" });

    orgToken = await mintToken(db, adminIdentityId, ["repo:read"], { orgId });
    adminOrgToken = await mintToken(db, adminIdentityId, ["admin"], { orgId });
    unscopedToken = await mintToken(db, adminIdentityId, ["admin"]);
    otherOrgToken = await mintToken(db, adminIdentityId, ["admin"], { orgId: otherOrgId });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("lists the token's org, and nothing at all for a token that is not org-scoped", async () => {
    const scoped = await api("/api/adp/orgs");
    expect(scoped.status).toBe(200);
    expect(scoped.body).toEqual([{ id: orgId, name: owner, kill_switch: false }]);

    // Same identity, same memberships, different token. Access is carried by
    // the token, so this one sees nothing — an empty list rather than a 403,
    // because "you have no org-scoped access" is a state, not a refusal.
    const unscoped = await api("/api/adp/orgs", {}, unscopedToken);
    expect(unscoped.status).toBe(200);
    expect(unscoped.body).toEqual([]);
  });

  it("refuses a token scoped to a different org", async () => {
    const res = await api(`/api/adp/orgs/${orgId}`, {}, otherOrgToken);
    expect(res.status).toBe(403);
  });

  it("reports an empty org floor, and says it is empty because no policy repo is designated", async () => {
    const res = await api(`/api/adp/orgs/${orgId}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      org_floor: { require: string[]; source: string };
      instance_floor: string[];
      policy_repo: unknown;
    };
    expect(body.org_floor).toEqual({ require: [], source: "no_policy_repo" });
    expect(body.instance_floor).toEqual(["gates_green"]);
    expect(body.policy_repo).toBeNull();
  });

  it("resolves instance ∪ org ∪ repo and attributes each requirement to every layer that asks for it", async () => {
    const policyRepo = await createRepoWithFile(
      "policy",
      "policy.yaml",
      "land:\n  require: [one_approval]\n",
    );
    await db.update(orgs).set({ policyRepoId: policyRepo.id }).where(eq(orgs.id, orgId));

    // This repo's own adp.yaml names a requirement the instance floor ALSO
    // names. That overlap is the case worth covering: the union must not
    // duplicate it, and the attribution must show both layers.
    await createRepoWithFile("governed", "adp.yaml", "land:\n  require: [gates_green]\n");

    const detail = await api(`/api/adp/orgs/${orgId}`);
    expect((detail.body as { org_floor: { require: string[]; source: string } }).org_floor).toEqual({
      require: ["one_approval"],
      source: "ok",
    });

    const res = await api(`/api/adp/orgs/${orgId}/repos`);
    expect(res.status).toBe(200);
    const items = res.body as {
      name: string;
      is_policy_repo: boolean;
      repo_requirements: string[];
      resolved: { requirement: string; from: string[] }[];
    }[];

    const governed = items.find((r) => r.name === "governed")!;
    expect(governed.repo_requirements).toEqual(["gates_green"]);
    expect(governed.resolved).toEqual([
      { requirement: "gates_green", from: ["instance", "repo"] },
      { requirement: "one_approval", from: ["org"] },
    ]);

    // A repo with no adp.yaml still inherits both layers above it.
    const seed = items.find((r) => r.name === "seed")!;
    expect(seed.repo_requirements).toEqual([]);
    expect(seed.resolved).toEqual([
      { requirement: "gates_green", from: ["instance"] },
      { requirement: "one_approval", from: ["org"] },
    ]);

    expect(items.find((r) => r.name === "policy")!.is_policy_repo).toBe(true);
    // 40s, not the 20s default: this test's setup is two real repos, real
    // pushes, and per-repo git reads for the console payload — ~13s on a
    // quiet run, and the suite runs 50+ files of git subprocess traffic
    // concurrently against one machine.
  }, 40_000);

  it("distinguishes a fail-closed floor from a deliberate one", async () => {
    // A policy.yaml that does not parse is failed closed to every known
    // requirement (core/org-policy.ts). That is the right enforcement
    // decision and a dangerous thing to render without comment, since it is
    // byte-identical to an org that deliberately requires everything.
    const brokenOwner = `${owner}-broken`;
    const [brokenIdentity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `org-console-broken-${Date.now()}` })
      .returning();
    const brokenBootstrap = await mintToken(db, brokenIdentity!.id, ["admin"]);
    // #91: provision the org first (this also seeds brokenIdentity's
    // membership), then create the policy repo inside it.
    const brokenOrgRes = await fetch(`http://127.0.0.1:${port}/api/adp/orgs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${brokenBootstrap}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: brokenOwner }),
    });
    const brokenOrgId = ((await brokenOrgRes.json()) as { id: string }).id;
    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${brokenOwner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${brokenBootstrap}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "policy" }),
    });
    const [brokenRepo] = await db
      .select()
      .from(repos)
      .where(and(eq(repos.owner, brokenOwner), eq(repos.name, "policy")));

    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-org-console-broken-"));
    const cloneUrl = `http://x-access-token:${brokenBootstrap}@127.0.0.1:${port}/${brokenOwner}/policy.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "printf 'land:\\n  require: [not_a_requirement]\\n' > policy.yaml"], {
      cwd: cloneDir,
    });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "broken policy"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    await rm(cloneDir, { recursive: true, force: true });

    await db.update(orgs).set({ policyRepoId: brokenRepo!.id }).where(eq(orgs.id, brokenOrgId));
    const brokenToken = await mintToken(db, brokenIdentity!.id, ["repo:read"], { orgId: brokenOrgId });

    const res = await api(`/api/adp/orgs/${brokenOrgId}`, {}, brokenToken);
    const body = res.body as { org_floor: { require: string[]; source: string } };
    expect(body.org_floor.source).toBe("malformed");
    expect(body.org_floor.require).toEqual(expect.arrayContaining(["gates_green", "one_approval"]));
  });

  it("counts quota usage with the same queries the enforcement paths use", async () => {
    await db.update(orgs).set({ maxRepos: 3 }).where(eq(orgs.id, orgId));

    const res = await api(`/api/adp/orgs/${orgId}`);
    const quotas = (res.body as { quotas: Record<string, { limit: number | null; used: number }> }).quotas;

    // seed + policy + governed, created above through the real route.
    expect(quotas.max_repos).toEqual({ limit: 3, used: 3 });
    // Untouched quotas read as unlimited, not as zero.
    expect(quotas.max_concurrent_workspaces).toEqual({ limit: null, used: 0 });
    expect(quotas.max_concurrent_gate_jobs).toEqual({ limit: null, used: 0 });
  });

  it("throws the kill switch, records it in the operation log, and refuses to do so without admin", async () => {
    const forbidden = await api(`/api/adp/orgs/${orgId}`, {
      method: "PATCH",
      body: JSON.stringify({ kill_switch: true }),
    });
    expect(forbidden.status).toBe(403);

    const engaged = await api(
      `/api/adp/orgs/${orgId}`,
      { method: "PATCH", body: JSON.stringify({ kill_switch: true }) },
      adminOrgToken,
    );
    expect(engaged.status).toBe(200);
    expect((engaged.body as { kill_switch: boolean }).kill_switch).toBe(true);

    const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
    expect(org!.killSwitch).toBe(true);

    // CLAUDE.md's invariant: the change and its operation row are written
    // together. repoId is null — this is the first genuinely org-global verb.
    const [op] = await db
      .select()
      .from(operations)
      .where(eq(operations.verb, "org.kill_switch"))
      .orderBy(desc(operations.createdAt))
      .limit(1);
    expect(op).toBeDefined();
    expect(op!.repoId).toBeNull();
    expect(op!.actorId).toBe(adminIdentityId);
    expect(op!.target).toBe(owner);
    expect(op!.before).toEqual({ kill_switch: false });
    expect(op!.after).toEqual({ kill_switch: true });

    const off = await api(
      `/api/adp/orgs/${orgId}`,
      { method: "PATCH", body: JSON.stringify({ kill_switch: false }) },
      adminOrgToken,
    );
    expect((off.body as { kill_switch: boolean }).kill_switch).toBe(false);
  });
});
