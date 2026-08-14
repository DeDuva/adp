import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { repoAccessCheck } from "../src/core/repos-lookup.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerIssueRoutes } from "../src/http-rest/issues.js";
import { registerOperationRoutes } from "../src/http-rest/operations.js";
import { registerWorkspaceRoutes } from "../src/http-rest/workspaces.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { loadGitHubSchema } from "../src/http-gql/schema.js";
import { attachResolvers } from "../src/http-gql/attach-resolvers.js";
import { createResolvers } from "../src/http-gql/resolvers.js";
import { registerGraphQLRoute } from "../src/http-gql/route.js";

const execFileAsync = promisify(execFile);

// #91 — the org-isolation MATRIX, M4 exit criterion #1
// (docs/m4-readiness-review.md §5.1; docs/m4-postmortem-audit.md §P0-1).
// Two organizations, provably non-interfering, across every plane the
// server exposes: /api/v3 REST, git smart-HTTP, GraphQL, and /api/adp.
// Every cross-org row answers 404 (or GraphQL null/NOT_FOUND) — never 403 —
// so an org-A token cannot even learn which org-B names exist. The audit's
// finding was that this boundary existed on 4 of ~98 operations; this file
// is the executable statement that it now exists everywhere it's probed,
// with positive controls proving the 404s come from authorization, not from
// the fixtures being broken.
describe.skipIf(skipWithoutDb)("#91: org isolation matrix (M4 exit criterion #1)", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;

  const ownerA = `iso-org-a-${Date.now()}`;
  const ownerB = `iso-org-b-${Date.now()}`;
  let aliceToken: string; // org-scoped to A; alice is a member of A only
  let malloryToken: string; // org-scoped to A; mallory is a member of BOTH orgs
  let bobToken: string; // org-scoped to B; bob is a member of B
  let operatorToken: string; // instance admin, no org — the bootstrap shape
  let repoBSha: string;
  let repoBGlobalId: string;

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

  async function gql(query: string, variables: Record<string, unknown>, token: string) {
    const res = await fetch(`http://127.0.0.1:${port}/api/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    return (await res.json()) as { data?: Record<string, unknown> | null; errors?: { extensions?: { code?: string } }[] };
  }

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-iso-git-"));
    const gitBackend = new GitBackend(gitRoot);

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerIssueRoutes(app, db);
    registerOperationRoutes(app, db, gitBackend);
    registerWorkspaceRoutes(app, db, gitBackend);
    const schema = loadGitHubSchema();
    attachResolvers(schema, createResolvers(gitBackend, "e2e-test-credential-key"));
    registerGraphQLRoute(app, schema, db);
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [alice] = await db.insert(identities).values({ kind: "human", principal: `iso-alice-${Date.now()}` }).returning();
    const [mallory] = await db.insert(identities).values({ kind: "human", principal: `iso-mallory-${Date.now()}` }).returning();
    const [bob] = await db.insert(identities).values({ kind: "human", principal: `iso-bob-${Date.now()}` }).returning();
    const [operator] = await db
      .insert(identities)
      .values({ kind: "human", principal: `iso-operator-${Date.now()}` })
      .returning();

    const orgAId = await grantOwner(db, alice!.id, ownerA);
    const orgBId = await grantOwner(db, bob!.id, ownerB);
    // Mallory is a member of BOTH orgs, but the token below is scoped to A —
    // the token carries the grant, not the person.
    await grantOwner(db, mallory!.id, ownerA);
    await grantOwner(db, mallory!.id, ownerB);

    aliceToken = await mintToken(db, alice!.id, ["repo:read", "repo:write"], { orgId: orgAId });
    malloryToken = await mintToken(db, mallory!.id, ["repo:read", "repo:write"], { orgId: orgAId });
    bobToken = await mintToken(db, bob!.id, ["repo:read", "repo:write"], { orgId: orgBId });
    operatorToken = await mintToken(db, operator!.id, ["repo:read", "repo:write", "admin"]);

    // Org B's repo, with real content — so the clone/push rows below fail
    // for the right reason and the positive controls can pass.
    await api(`/api/v3/repos/${ownerB}`, bobToken, { method: "POST", body: JSON.stringify({ name: "secrets" }) });
    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-iso-clone-"));
    const cloneUrl = `http://x-access-token:${bobToken}@127.0.0.1:${port}/${ownerB}/secrets.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "bob@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Bob"], { cwd: cloneDir });
    await writeFile(path.join(cloneDir, "secret.txt"), "org-b-only\n");
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "org B's commit"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    repoBSha = (await execFileAsync("git", ["rev-parse", "main"], { cwd: cloneDir })).stdout.trim();
    await rm(cloneDir, { recursive: true, force: true });

    const viaBob = await gql(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }`,
      { owner: ownerB, name: "secrets" },
      bobToken,
    );
    repoBGlobalId = (viaBob.data!.repository as { id: string }).id;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("/api/v3: org A cannot read, write into, or even detect org B's repo", async () => {
    expect((await api(`/api/v3/repos/${ownerB}/secrets`, aliceToken)).status).toBe(404);
    expect((await api(`/api/v3/repos/${ownerB}/secrets/issues`, aliceToken)).status).toBe(404);
    expect(
      (
        await api(`/api/v3/repos/${ownerB}/secrets/issues`, aliceToken, {
          method: "POST",
          body: JSON.stringify({ title: "cross-tenant write" }),
        })
      ).status,
    ).toBe(404);
    // Repo-create in B's org is refused too — and as a 403, not a 404: the
    // org's existence is already public in the sense that creating "again"
    // must not succeed, and the audit names 403 for non-member creation.
    expect(
      (await api(`/api/v3/repos/${ownerB}`, aliceToken, { method: "POST", body: JSON.stringify({ name: "intruder" }) }))
        .status,
    ).toBe(403);
  });

  it("/api/v3: a token scoped to org A is refused on org B even when its HOLDER belongs to both — the token carries the grant", async () => {
    expect((await api(`/api/v3/repos/${ownerB}/secrets`, malloryToken)).status).toBe(404);
  });

  it("git http: org A can neither clone nor push org B's repo", async () => {
    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-iso-alice-"));
    const aliceUrl = `http://x-access-token:${aliceToken}@127.0.0.1:${port}/${ownerB}/secrets.git`;
    await expect(execFileAsync("git", ["clone", aliceUrl, path.join(cloneDir, "clone")])).rejects.toThrow(/not found/);

    // Push without a prior clone: an empty repo with B's remote — the push
    // is refused at the same 404 the clone was, so nothing about refs leaks.
    const pushDir = path.join(cloneDir, "push");
    await execFileAsync("git", ["init", "-b", "main", pushDir]);
    await execFileAsync("git", ["config", "user.email", "alice@example.com"], { cwd: pushDir });
    await execFileAsync("git", ["config", "user.name", "Alice"], { cwd: pushDir });
    await writeFile(path.join(pushDir, "f.txt"), "x\n");
    await execFileAsync("git", ["add", "."], { cwd: pushDir });
    await execFileAsync("git", ["commit", "-m", "attempt"], { cwd: pushDir });
    await expect(execFileAsync("git", ["push", aliceUrl, "main"], { cwd: pushDir })).rejects.toThrow(/not found/);
    await rm(cloneDir, { recursive: true, force: true });
  });

  it("GraphQL: repository, node, and createIssue are all null/NOT_FOUND for org A against org B", async () => {
    const viaAlice = await gql(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }`,
      { owner: ownerB, name: "secrets" },
      aliceToken,
    );
    expect(viaAlice.data!.repository).toBeNull();

    const nodeViaAlice = await gql(`query($id: ID!) { node(id: $id) { __typename } }`, { id: repoBGlobalId }, aliceToken);
    expect(nodeViaAlice.data!.node).toBeNull();

    const mutViaAlice = await gql(
      `mutation($input: CreateIssueInput!) { createIssue(input: $input) { issue { number } } }`,
      { input: { repositoryId: repoBGlobalId, title: "cross-tenant" } },
      aliceToken,
    );
    expect(mutViaAlice.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });

  it("/api/adp: workspaces and the operation log are 404 for org A against org B", async () => {
    expect(
      (
        await api(`/api/adp/repos/${ownerB}/secrets/workspaces`, aliceToken, {
          method: "POST",
          body: JSON.stringify({ base_ref: "main" }),
        })
      ).status,
    ).toBe(404);
    expect((await api(`/api/adp/repos/${ownerB}/secrets/operations`, aliceToken)).status).toBe(404);
  });

  it("positive controls: the same rows succeed for org B's own token, and for the instance operator", async () => {
    expect((await api(`/api/v3/repos/${ownerB}/secrets`, bobToken)).status).toBe(200);
    expect((await api(`/api/v3/repos/${ownerB}/secrets`, operatorToken)).status).toBe(200);
    expect((await api(`/api/adp/repos/${ownerB}/secrets/operations`, bobToken)).status).toBe(200);

    const viaOperator = await gql(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }`,
      { owner: ownerB, name: "secrets" },
      operatorToken,
    );
    expect(viaOperator.data!.repository).not.toBeNull();

    // And the content really is there — the 404s above were authorization,
    // not a broken fixture.
    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-iso-bob-"));
    await execFileAsync("git", [
      "clone",
      `http://x-access-token:${bobToken}@127.0.0.1:${port}/${ownerB}/secrets.git`,
      path.join(cloneDir, "clone"),
    ]);
    const log = await execFileAsync("git", ["log", "--oneline"], { cwd: path.join(cloneDir, "clone") });
    expect(log.stdout).toContain("org B's commit");
    expect(repoBSha).toMatch(/^[0-9a-f]{40}$/);
    await rm(cloneDir, { recursive: true, force: true });
  });
});
