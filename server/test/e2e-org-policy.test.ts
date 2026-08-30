import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { identities, orgs, repos } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { repoAccessCheck } from "../src/core/repos-lookup.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerProposalRoutes } from "../src/http-rest/proposals.js";
import { registerReviewRoutes } from "../src/http-rest/reviews.js";

const execFileAsync = promisify(execFile);

// M4-2: the org policy plane proven through
// the real land path, the same rigor e2e-gates.test.ts holds instance-floor
// and repo-policy enforcement to. Instance floor is deliberately empty here —
// this file is about isolating what the *org* level contributes, not
// re-proving instance/repo behavior that's already covered elsewhere.
//
// There is no REST route to set repos.orgId / orgs.killSwitch / orgs.
// policyRepoId yet (M4-2's scope, recorded in its PR description — org
// management is M4-7's job, this item is the resolution mechanism), so this
// test sets them directly via the DB, the same way a future route would.
describe.skipIf(skipWithoutDb)("M4-2: org policy plane", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  // #121: the org-sourced `one_approval` below is author-independent, so
  // satisfying it takes a principal that is not the proposal's author.
  let reviewerToken: string;
  const owner = `org-policy-owner-${Date.now()}`;

  async function apiAs(asToken: string, pathAndQuery: string, init: RequestInit = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
      ...init,
      headers: { Authorization: `Bearer ${asToken}`, "Content-Type": "application/json", ...init.headers },
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

  const api = (pathAndQuery: string, init: RequestInit = {}) => apiAs(token, pathAndQuery, init);

  async function repoRow(name: string) {
    const [row] = await db.select().from(repos).where(and(eq(repos.owner, owner), eq(repos.name, name)));
    return row!;
  }

  async function assignOrg(repoName: string, orgId: string) {
    await db.update(repos).set({ orgId }).where(and(eq(repos.owner, owner), eq(repos.name, repoName)));
  }

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-org-policy-git-"));
    const gitBackend = new GitBackend(gitRoot);

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    // Empty instance floor — this file is about what the org level adds on
    // its own, not about instance/repo behavior already covered elsewhere.
    registerProposalRoutes(app, db, gitBackend, "e2e-org-policy-credential-key", []);
    registerReviewRoutes(app, db);
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `org-policy-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);

    const [reviewer] = await db
      .insert(identities)
      .values({ kind: "human", principal: `org-policy-e2e-reviewer-${Date.now()}` })
      .returning();
    reviewerToken = await mintToken(db, reviewer!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, reviewer!.id, owner);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  async function pushOpenAndReturnPr(repoName: string) {
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: repoName }) });

    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-org-policy-clone-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo base > README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });

    await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo more >> README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "feature commit"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "feature"], { cwd: cloneDir });
    await rm(cloneDir, { recursive: true, force: true });

    const createRes = await api(`/api/v3/repos/${owner}/${repoName}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: "Add more", head: "feature", base: "main" }),
    });
    return createRes.body as { number: number };
  }

  it("lands freely with no org at all (empty instance floor, no repo policy)", async () => {
    const pr = await pushOpenAndReturnPr("no-org");
    const merged = await api(`/api/v3/repos/${owner}/no-org/pulls/${pr.number}/merge`, { method: "PUT", body: "{}" });
    expect(merged.status).toBe(200);
  });

  it("refuses every land while the org's kill switch is active, with no other requirement in play", async () => {
    const repoName = "killed";
    const pr = await pushOpenAndReturnPr(repoName);

    const [org] = await db.insert(orgs).values({ name: `kill-switch-org-${Date.now()}`, killSwitch: true }).returning();
    await assignOrg(repoName, org!.id);

    const attempt = await api(`/api/v3/repos/${owner}/${repoName}/pulls/${pr.number}/merge`, { method: "PUT", body: "{}" });
    expect(attempt.status).toBe(422);
    const body = attempt.body as { unmet: string[]; unmet_detail: { requirement: string; remedy: string }[] };
    expect(body.unmet).toHaveLength(1);
    expect(body.unmet_detail).toHaveLength(1);
    expect(body.unmet_detail[0]!.requirement).toBe("org_kill_switch");
    // #145: the kill switch is the one refusal nothing on the proposal can
    // clear, so the remedy has to say that rather than send the user round the
    // gate-and-approve loop it does not respond to.
    expect(body.unmet_detail[0]!.remedy).toMatch(/org admin/);
    expect(body.unmet[0]!).toContain("org_kill_switch");
    expect(body.unmet[0]!).toContain("kill_switch");
  });

  it("enforces a requirement named only in the org's policy repo, on top of an empty instance floor and no repo policy", async () => {
    // The org's designated policy repo, with policy.yaml on its default branch.
    const policyRepoName = "org-policy-repo";
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: policyRepoName }) });
    const policyCloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-org-policy-policyrepo-"));
    const policyCloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${policyRepoName}.git`;
    await execFileAsync("git", ["clone", policyCloneUrl, policyCloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: policyCloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: policyCloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: policyCloneDir });
    await execFileAsync("sh", ["-c", "printf 'land:\\n  require: [one_approval]\\n' > policy.yaml"], {
      cwd: policyCloneDir,
    });
    await execFileAsync("git", ["add", "."], { cwd: policyCloneDir });
    await execFileAsync("git", ["commit", "-m", "org policy"], { cwd: policyCloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: policyCloneDir });
    await rm(policyCloneDir, { recursive: true, force: true });

    const policyRepo = await repoRow(policyRepoName);
    const [org] = await db
      .insert(orgs)
      .values({ name: `policy-org-${Date.now()}`, policyRepoId: policyRepo.id })
      .returning();

    const targetRepoName = "org-governed";
    const pr = await pushOpenAndReturnPr(targetRepoName);
    await assignOrg(targetRepoName, org!.id);

    // Not approved yet — refused, and specifically on the org-sourced requirement.
    const attempt1 = await api(`/api/v3/repos/${owner}/${targetRepoName}/pulls/${pr.number}/merge`, {
      method: "PUT",
      body: "{}",
    });
    expect(attempt1.status).toBe(422);
    expect((attempt1.body as { unmet: string[] }).unmet.join(" ")).toMatch(/one_approval/);

    // The author's own approval does not satisfy an org-sourced requirement
    // any more than an instance-sourced one (#121) — the check lives in the
    // resolved requirement, so every level that can name it inherits this.
    await api(`/api/v3/repos/${owner}/${targetRepoName}/pulls/${pr.number}/reviews`, {
      method: "POST",
      body: JSON.stringify({ state: "approved", body: "lgtm, me" }),
    });
    const attempt2 = await api(`/api/v3/repos/${owner}/${targetRepoName}/pulls/${pr.number}/merge`, {
      method: "PUT",
      body: "{}",
    });
    expect(attempt2.status).toBe(422);
    expect((attempt2.body as { unmet: string[] }).unmet.join(" ")).toMatch(/one_approval/);

    await apiAs(reviewerToken, `/api/v3/repos/${owner}/${targetRepoName}/pulls/${pr.number}/reviews`, {
      method: "POST",
      body: JSON.stringify({ state: "approved", body: "lgtm" }),
    });
    const merged = await api(`/api/v3/repos/${owner}/${targetRepoName}/pulls/${pr.number}/merge`, {
      method: "PUT",
      body: "{}",
    });
    expect(merged.status).toBe(200);
  });
});
