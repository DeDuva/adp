import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq, and } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { identities, gateResults } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerProposalRoutes } from "../src/http-rest/proposals.js";
import { registerReviewRoutes } from "../src/http-rest/reviews.js";
import { registerDependencyAdmissionRoutes } from "../src/http-rest/dependency-admission.js";

const execFileAsync = promisify(execFile);

// M2: dependency admission v0 (docs/pragmatic_mvp.md) — a lockfile diff
// becomes a typed gate. Uses the real OSV.dev + npm registry APIs (no
// fetch mocking, unlike core/dependency-admission.test.ts's mocked cases) —
// same live-network posture as that file's "live network" describe block,
// against real packages: `sdxcode1@9.9.9` is a real OpenSSF-reported
// malicious npm package (MAL-2025-2155), `is-odd@3.0.1` is real, old, and
// clean.
describe.skipIf(skipWithoutDb)("M2: dependency admission", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  const owner = `dep-admission-owner-${Date.now()}`;

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

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-dep-admission-git-"));
    const gitBackend = new GitBackend(gitRoot);
    const signer = new Signer("e2e-dep-admission-signing-key");

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend);
    registerProposalRoutes(app, db, gitBackend, "e2e-test-credential-key", ["gates_green"]);
    registerReviewRoutes(app, db);
    registerDependencyAdmissionRoutes(app, db, signer, "https://adp.example.com");
    registerGitHttpRoutes(app, gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `dep-admission-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it(
    "reports typed per-package verdicts and stores a DSSE-signed gate result",
    async () => {
      const repoName = "widget";
      await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: repoName }) });
      const sha = "a".repeat(40);

      const res = await api(`/api/v3/repos/${owner}/${repoName}/dependency-admission`, {
        method: "POST",
        body: JSON.stringify({
          git_sha: sha,
          packages: [
            { ecosystem: "npm", name: "is-odd", version: "3.0.1" },
            { ecosystem: "npm", name: "sdxcode1", version: "9.9.9" },
          ],
        }),
      });

      expect(res.status).toBe(201);
      const body = res.body as {
        status: string;
        packages: { name: string; verdict: string; reasons: string[] }[];
        envelope: { payloadType: string };
      };
      expect(body.status).toBe("failure"); // one blocked package outranks the other's admit
      expect(body.envelope.payloadType).toBe("application/vnd.in-toto+json");

      const isOdd = body.packages.find((p) => p.name === "is-odd");
      const sdxcode1 = body.packages.find((p) => p.name === "sdxcode1");
      expect(isOdd?.verdict).toBe("admit");
      expect(sdxcode1?.verdict).toBe("block");
      expect(sdxcode1?.reasons.join(" ")).toContain("MAL-");

      const rows = await db.select().from(gateResults).where(and(eq(gateResults.gitSha, sha), eq(gateResults.name, "dependency-admission")));
      expect(rows.some((r) => r.status === "failure")).toBe(true);
    },
    20_000,
  );

  it(
    "blocks a merge via gates_green until dependency-admission reports clean, then allows it",
    async () => {
      const repoName = "widget2";
      await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: repoName }) });

      const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-dep-admission-clone-"));
      const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
      await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
      await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
      // A repo opts in by naming this gate in adp.yaml, read off the base
      // ref — no server-side land-policy code change needed for that.
      await execFileAsync("sh", ["-c", "printf 'gates:\\n  - dependency-admission\\nland:\\n  require: []\\n' > adp.yaml"], {
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

      // No dependency-admission report at all yet — gates_green refuses.
      const attempt1 = await api(`/api/v3/repos/${owner}/${repoName}/pulls/${pr.number}/merge`, { method: "PUT", body: "{}" });
      expect(attempt1.status).toBe(422);
      expect((attempt1.body as { unmet: string[] }).unmet.join(" ")).toMatch(/gates_green/);

      // A quarantined (unverifiable) package reports "pending" — not green either.
      await api(`/api/v3/repos/${owner}/${repoName}/dependency-admission`, {
        method: "POST",
        body: JSON.stringify({
          git_sha: headSha,
          packages: [{ ecosystem: "npm", name: "this-package-does-not-exist-adp-e2e-xyz", version: "1.0.0" }],
        }),
      });
      const attempt2 = await api(`/api/v3/repos/${owner}/${repoName}/pulls/${pr.number}/merge`, { method: "PUT", body: "{}" });
      expect(attempt2.status).toBe(422);

      // A clean, admitted package (a rerun for the same sha) reports "success" — now green.
      await api(`/api/v3/repos/${owner}/${repoName}/dependency-admission`, {
        method: "POST",
        body: JSON.stringify({ git_sha: headSha, packages: [{ ecosystem: "npm", name: "is-odd", version: "3.0.1" }] }),
      });
      const attempt3 = await api(`/api/v3/repos/${owner}/${repoName}/pulls/${pr.number}/merge`, { method: "PUT", body: "{}" });
      expect(attempt3.status).toBe(200);
      expect((attempt3.body as { merged: boolean }).merged).toBe(true);
    },
    20_000,
  );
});
