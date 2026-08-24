import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type Db } from "../src/db/client.js";
import { identities } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { repoAccessCheck } from "../src/core/repos-lookup.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerProposalRoutes } from "../src/http-rest/proposals.js";
import { registerReviewRoutes } from "../src/http-rest/reviews.js";
import { registerGateRoutes } from "../src/http-rest/gates.js";
import { loadGitHubSchema } from "../src/http-gql/schema.js";
import { attachResolvers } from "../src/http-gql/attach-resolvers.js";
import { createResolvers } from "../src/http-gql/resolvers.js";
import { registerGraphQLRoute } from "../src/http-gql/route.js";

const execFileAsync = promisify(execFile);

// M1c: the adp.yaml gate runner + two-level land policy
// — this is the enforcement point the
// receive-path hooks and evidence bundles all feed into: a merge is refused
// until the resolved requirements (instance floor ∧ repo adp.yaml) are met.
describe.skipIf(skipWithoutDb)("M1c: gate runner + land policy", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  const owner = `gates-owner-${Date.now()}`;

  async function api(pathAndQuery: string, init: RequestInit = {}) {
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

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-gates-git-"));
    const gitBackend = new GitBackend(gitRoot);
    const signer = new Signer("e2e-gates-signing-key");

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    // Instance floor requires both — same default as config.ts's
    // LAND_POLICY_FLOOR, made explicit here rather than relying on it.
    registerProposalRoutes(app, db, gitBackend, "e2e-test-credential-key", ["gates_green", "one_approval"]);
    registerReviewRoutes(app, db);
    registerGateRoutes(app, db, signer, "https://adp.example.com", "e2e-test-credential-key");
    const gqlSchema = loadGitHubSchema();
    attachResolvers(
      gqlSchema,
      createResolvers(gitBackend, "e2e-test-credential-key", ["gates_green", "one_approval"], {
        signer,
        publicUrl: "https://adp.example.com",
      }),
    );
    registerGraphQLRoute(app, gqlSchema, db);
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `gates-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("blocks a merge until required gates are green and the PR is approved, then allows it", async () => {
    const repoName = "widget";
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: repoName }) });

    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-gates-clone-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    // adp.yaml on main names one required gate — read off the *base* ref
    // (core/land-policy.ts), so it has to be on main, not the PR branch.
    await execFileAsync("sh", ["-c", "printf 'gates:\\n  - tests\\nland:\\n  require: []\\n' > adp.yaml"], {
      cwd: cloneDir,
    });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });

    await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo more >> README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "feature commit"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "feature"], { cwd: cloneDir });
    const headSha = (await execFileAsync("git", ["rev-parse", "feature"], { cwd: cloneDir })).stdout.trim();
    await rm(cloneDir, { recursive: true, force: true });

    const createRes = await api(`/api/v3/repos/${owner}/${repoName}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: "Add more", head: "feature", base: "main" }),
    });
    const pr = createRes.body as { number: number };

    // Neither requirement met yet.
    const attempt1 = await api(`/api/v3/repos/${owner}/${repoName}/pulls/${pr.number}/merge`, {
      method: "PUT",
      body: "{}",
    });
    expect(attempt1.status).toBe(422);
    expect((attempt1.body as { unmet: string[] }).unmet.join(" ")).toMatch(/gates_green/);
    expect((attempt1.body as { unmet: string[] }).unmet.join(" ")).toMatch(/one_approval/);

    // Report the gate as failing — still blocked, and specifically on gates_green.
    const failingReport = await api(`/api/v3/repos/${owner}/${repoName}/gates`, {
      method: "POST",
      body: JSON.stringify({ git_sha: headSha, name: "tests", status: "failure", summary: "2 failing" }),
    });
    expect(failingReport.status).toBe(201);
    expect((failingReport.body as { envelope: { payloadType: string } }).envelope.payloadType).toBe(
      "application/vnd.in-toto+json",
    );

    const attempt2 = await api(`/api/v3/repos/${owner}/${repoName}/pulls/${pr.number}/merge`, { method: "PUT", body: "{}" });
    expect(attempt2.status).toBe(422);
    expect((attempt2.body as { unmet: string[] }).unmet.join(" ")).toMatch(/gates_green/);

    // Report success (a rerun) — gates_green now satisfied, but not approved yet.
    await api(`/api/v3/repos/${owner}/${repoName}/gates`, {
      method: "POST",
      body: JSON.stringify({ git_sha: headSha, name: "tests", status: "success", summary: "all green" }),
    });
    const attempt3 = await api(`/api/v3/repos/${owner}/${repoName}/pulls/${pr.number}/merge`, { method: "PUT", body: "{}" });
    expect(attempt3.status).toBe(422);
    expect((attempt3.body as { unmet: string[] }).unmet.join(" ")).toMatch(/one_approval/);
    expect((attempt3.body as { unmet: string[] }).unmet.join(" ")).not.toMatch(/gates_green/);

    // Approve — now both requirements are met.
    await api(`/api/v3/repos/${owner}/${repoName}/pulls/${pr.number}/reviews`, {
      method: "POST",
      body: JSON.stringify({ state: "approved", body: "lgtm" }),
    });
    const merged = await api(`/api/v3/repos/${owner}/${repoName}/pulls/${pr.number}/merge`, { method: "PUT", body: "{}" });
    expect(merged.status).toBe(200);

    const gateList = await api(`/api/v3/repos/${owner}/${repoName}/commits/${headSha}/gates`);
    expect((gateList.body as unknown[]).length).toBe(2); // failure + success reports both retained
  });

  // What `gh pr checks` actually reads. The aggregate `state` was always real;
  // `contexts` used to be an empty connection, so gh reported "no checks
  // reported" and exited nonzero on a green rollup — an agent could not see why
  // its own CI passed, which is the hole the evidence plane exists to close.
  it("projects gate results as StatusContexts on the rollup, with links to their evidence", async () => {
    const repoName = "rollup";
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: repoName }) });

    const dir = await mkdtemp(path.join(tmpdir(), "adp-e2e-rollup-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, dir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
    await execFileAsync("sh", ["-c", "echo hi > README.md"], { cwd: dir });
    await execFileAsync("git", ["add", "."], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: dir });
    await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: dir });
    await execFileAsync("sh", ["-c", "echo more >> README.md"], { cwd: dir });
    await execFileAsync("git", ["add", "."], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "feature"], { cwd: dir });
    await execFileAsync("git", ["push", "origin", "feature"], { cwd: dir });
    const sha = (await execFileAsync("git", ["rev-parse", "feature"], { cwd: dir })).stdout.trim();
    await rm(dir, { recursive: true, force: true });

    const created = await api(`/api/v3/repos/${owner}/${repoName}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: "rollup", head: "feature", base: "main" }),
    });
    const number = (created.body as { number: number }).number;

    for (const gate of [
      { name: "lint", status: "success", summary: "clean" },
      { name: "tests", status: "failure", summary: "2 failing" },
    ]) {
      await api(`/api/v3/repos/${owner}/${repoName}/gates`, {
        method: "POST",
        body: JSON.stringify({ git_sha: sha, ...gate }),
      });
    }

    // The traversal `gh pr checks` performs: PR → commits → commit → rollup.
    const query = `query { repository(owner:"${owner}", name:"${repoName}") {
      pullRequest(number:${number}) { commits(first:10) { nodes { commit { oid
        statusCheckRollup { state contexts(first:100) {
          checkRunCount statusContextCount
          nodes { __typename ... on StatusContext { context state description targetUrl isRequired } } } } } } } } } }`;

    const res = await api("/api/graphql", { method: "POST", body: JSON.stringify({ query }) });
    expect(res.status).toBe(200);
    const rollup = (res.body as { data: { repository: { pullRequest: { commits: { nodes: { commit: { statusCheckRollup: unknown } }[] } } } } })
      .data.repository.pullRequest.commits.nodes.map((n) => n.commit.statusCheckRollup)
      .find(Boolean) as {
      state: string;
      contexts: {
        checkRunCount: number;
        statusContextCount: number;
        nodes: { __typename: string; context: string; state: string; description: string; targetUrl: string; isRequired: boolean }[];
      };
    };

    // One failing gate makes the aggregate FAILURE, regardless of the green one.
    expect(rollup.state).toBe("FAILURE");

    const contexts = rollup.contexts.nodes;
    expect(contexts).toHaveLength(2);
    expect(rollup.contexts.statusContextCount).toBe(2);
    // Never a CheckRun: that shape implies a CheckSuite and a WorkflowRun, an
    // execution model ADP deliberately does not have (§2.5).
    expect(rollup.contexts.checkRunCount).toBe(0);
    expect(contexts.every((c) => c.__typename === "StatusContext")).toBe(true);

    const byName = new Map(contexts.map((c) => [c.context, c]));
    expect(byName.get("lint")!.state).toBe("SUCCESS");
    expect(byName.get("tests")!.state).toBe("FAILURE");
    // The summary an agent needs in order to act, not just a colour.
    expect(byName.get("tests")!.description).toBe("2 failing");
    // The link points at the evidence bundle — the DSSE envelope behind the
    // verdict — rather than at a CI dashboard that does not exist here.
    expect(byName.get("tests")!.targetUrl).toBe(
      `https://adp.example.com/api/adp/repos/${owner}/${repoName}/evidence/${sha}`,
    );
    // Land policy decides what is required, per repo, from adp.yaml — reporting
    // `true` here would tell gh a gate blocks merging when the repo may not
    // require it at all.
    expect(contexts.every((c) => c.isRequired === false)).toBe(true);
  }, 120_000);
});
