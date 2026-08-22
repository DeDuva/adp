import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type Db } from "../src/db/client.js";
import { identities } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { decodeStatement, type DsseEnvelope } from "../src/core/dsse.js";
import type { CycloneDxSbom } from "../src/core/sbom.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { repoAccessCheck } from "../src/core/repos-lookup.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerProposalRoutes } from "../src/http-rest/proposals.js";
import { registerEvidenceRoutes } from "../src/http-rest/evidence.js";
import { loadGitHubSchema } from "../src/http-gql/schema.js";
import { attachResolvers } from "../src/http-gql/attach-resolvers.js";
import { createResolvers } from "../src/http-gql/resolvers.js";
import { registerGraphQLRoute } from "../src/http-gql/route.js";
import { toGlobalId } from "../src/http-gql/global-id.js";

const execFileAsync = promisify(execFile);
const FIXTURE_LOCKFILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/sbom-package-lock.json");

interface GraphQLResponse<T = unknown> {
  data: T | null;
  errors?: { message: string }[];
}

// M2: SBOM per land (docs/pragmatic_mvp.md) — CycloneDX emitted as ordinary
// evidence on every landed change. Real npm lockfile fixture (test/fixtures/
// sbom-package-lock.json, captured from a real `npm install`), pushed and
// merged for real, then read back through the same evidence-bundle endpoint
// (core/evidence.ts) a gate result already surfaces through.
describe.skipIf(skipWithoutDb)("M2: SBOM per land", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  const owner = `sbom-owner-${Date.now()}`;

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

  async function gql<T = unknown>(query: string, variables?: Record<string, unknown>) {
    const res = await fetch(`http://127.0.0.1:${port}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
    });
    return { status: res.status, body: (await res.json()) as GraphQLResponse<T> };
  }

  async function pushFeatureWithLockfile(repoName: string): Promise<{ headSha: string }> {
    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-sbom-clone-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo hi > README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });

    await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: cloneDir });
    await copyFile(FIXTURE_LOCKFILE, path.join(cloneDir, "package-lock.json"));
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "add lockfile"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "feature"], { cwd: cloneDir });
    const headSha = (await execFileAsync("git", ["rev-parse", "feature"], { cwd: cloneDir })).stdout.trim();
    await rm(cloneDir, { recursive: true, force: true });
    return { headSha };
  }

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-sbom-git-"));
    const gitBackend = new GitBackend(gitRoot);
    const signer = new Signer("e2e-sbom-signing-key");

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerProposalRoutes(app, db, gitBackend, "e2e-test-credential-key", [], { signer, publicUrl: "https://adp.example.com" });
    registerEvidenceRoutes(app, db);

    const schema = loadGitHubSchema();
    attachResolvers(schema, createResolvers(gitBackend, "e2e-test-credential-key", [], { signer, publicUrl: "https://adp.example.com" }));
    registerGraphQLRoute(app, schema, db);

    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;
    gitBackend.setInternalUrl(`http://127.0.0.1:${port}`);

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `sbom-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("REST merge records a CycloneDX SBOM as gate evidence for the merged sha", async () => {
    const repoName = "widget";
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: repoName }) });
    const { headSha } = await pushFeatureWithLockfile(repoName);

    const createRes = await api(`/api/v3/repos/${owner}/${repoName}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: "Add lockfile", head: "feature", base: "main" }),
    });
    const pr = createRes.body as { number: number };

    const mergeRes = await api(`/api/v3/repos/${owner}/${repoName}/pulls/${pr.number}/merge`, { method: "PUT", body: "{}" });
    expect(mergeRes.status).toBe(200);

    const evidence = await api(`/api/adp/repos/${owner}/${repoName}/evidence/${headSha}`);
    const gates = (evidence.body as { gates: { name: string; status: string; envelope: unknown }[] }).gates;
    const sbomGate = gates.find((g) => g.name === "sbom");
    expect(sbomGate).toBeTruthy();
    expect(sbomGate!.status).toBe("success");

    const statement = decodeStatement(sbomGate!.envelope as DsseEnvelope);
    expect(statement.predicateType).toBe("https://cyclonedx.org/bom");
    const sbom = statement.predicate as CycloneDxSbom;
    expect(sbom.bomFormat).toBe("CycloneDX");
    expect(sbom.components.some((c) => c.name === "is-odd" && c.version === "3.0.1")).toBe(true);
    expect(sbom.components.some((c) => c.name === "lodash" && c.version === "4.17.15")).toBe(true);
    expect(sbom.metadata.component.version).toBe(headSha);
  });

  it("GraphQL mergePullRequest also records the SBOM", async () => {
    const repoName = "widget-gql";
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: repoName }) });
    const { headSha } = await pushFeatureWithLockfile(repoName);

    const repoRes = await api(`/api/v3/repos/${owner}/${repoName}`);
    const repoId = toGlobalId("Repository", (repoRes.body as { id: string }).id);

    const created = await gql<{ createPullRequest: { pullRequest: { id: string } } }>(
      `mutation($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { id } } }`,
      { input: { repositoryId: repoId, title: "Add lockfile", baseRefName: "main", headRefName: "feature" } },
    );
    const prId = created.body.data!.createPullRequest.pullRequest.id;

    const merged = await gql<{ mergePullRequest: { pullRequest: { state: string } } }>(
      `mutation($input: MergePullRequestInput!) { mergePullRequest(input: $input) { pullRequest { state } } }`,
      { input: { pullRequestId: prId } },
    );
    expect(merged.body.errors).toBeUndefined();
    expect(merged.body.data!.mergePullRequest.pullRequest.state).toBe("MERGED");

    const evidence = await api(`/api/adp/repos/${owner}/${repoName}/evidence/${headSha}`);
    const gates = (evidence.body as { gates: { name: string; status: string }[] }).gates;
    expect(gates.some((g) => g.name === "sbom" && g.status === "success")).toBe(true);
  });
});
