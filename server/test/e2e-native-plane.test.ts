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
import { registerChangeRoutes } from "../src/http-rest/changes.js";
import { registerGateRoutes } from "../src/http-rest/gates.js";
import { registerWorkspaceRoutes } from "../src/http-rest/workspaces.js";
import { registerEvidenceRoutes } from "../src/http-rest/evidence.js";

const execFileAsync = promisify(execFile);

// M1c native plane, remaining slices: workspaces (a branch with lifecycle
// metadata) and adp_evidence_get's REST backing
// (the consolidated signed-change + gate-results view).
describe.skipIf(skipWithoutDb)("M1c: workspaces + evidence bundle", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let gitBackend: GitBackend;
  let port: number;
  let token: string;
  const owner = `native-owner-${Date.now()}`;
  const repoName = "widget";

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

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-native-git-"));
    gitBackend = new GitBackend(gitRoot);
    const signer = new Signer("e2e-native-signing-key");

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerChangeRoutes(app, db, gitBackend, signer);
    registerGateRoutes(app, db, signer, "https://adp.example.com", "e2e-test-credential-key");
    registerWorkspaceRoutes(app, db, gitBackend);
    registerEvidenceRoutes(app, db);
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `native-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);

    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: repoName }) });

    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-native-clone-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo hi > README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    await rm(cloneDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("creates a workspace as a real branch, lists it, then destroys it (ref actually gone)", async () => {
    const createRes = await api(`/api/adp/repos/${owner}/${repoName}/workspaces`, {
      method: "POST",
      body: JSON.stringify({ base_ref: "main" }),
    });
    expect(createRes.status).toBe(201);
    const ws = createRes.body as { id: string; branch: string; base_sha: string };
    expect(ws.branch).toMatch(/^adp\/ws\//);

    expect(await gitBackend.resolveRef(owner, repoName, ws.branch)).toBe(ws.base_sha);

    const list = await api(`/api/adp/repos/${owner}/${repoName}/workspaces`);
    expect((list.body as { id: string }[]).some((w) => w.id === ws.id)).toBe(true);

    const destroyRes = await api(`/api/adp/repos/${owner}/${repoName}/workspaces/${ws.id}`, {
      method: "DELETE",
    });
    expect(destroyRes.status).toBe(204);
    expect(await gitBackend.resolveRef(owner, repoName, ws.branch)).toBeNull();

    // Destroying an already-destroyed workspace is refused, not a silent no-op.
    const secondDestroy = await api(`/api/adp/repos/${owner}/${repoName}/workspaces/${ws.id}`, {
      method: "DELETE",
    });
    expect(secondDestroy.status).toBe(422);
  });

  it("assembles an evidence bundle from a signed change plus reported gate results", async () => {
    const headSha = (await gitBackend.resolveRef(owner, repoName, "main"))!;

    const changeRes = await api(`/api/v3/repos/${owner}/${repoName}/changes`, {
      method: "POST",
      body: JSON.stringify({ git_sha: headSha }),
    });
    expect(changeRes.status).toBe(201);

    await api(`/api/v3/repos/${owner}/${repoName}/gates`, {
      method: "POST",
      body: JSON.stringify({ git_sha: headSha, name: "tests", status: "success", summary: "ok" }),
    });

    const bundle = await api(`/api/adp/repos/${owner}/${repoName}/evidence/${headSha}`);
    expect(bundle.status).toBe(200);
    const body = bundle.body as {
      git_sha: string;
      change: { signature: string } | null;
      gates: { name: string; status: string; envelope: { payloadType: string } }[];
    };
    expect(body.git_sha).toBe(headSha);
    expect(body.change?.signature).toBeTruthy();
    expect(body.gates).toHaveLength(1);
    expect(body.gates[0]!.name).toBe("tests");
    expect(body.gates[0]!.envelope.payloadType).toBe("application/vnd.in-toto+json");
  });

  it("returns an empty-but-shaped bundle for a commit with no change or gate history", async () => {
    const bundle = await api(`/api/adp/repos/${owner}/${repoName}/evidence/${"f".repeat(40)}`);
    expect(bundle.status).toBe(200);
    // #157: `produced_by` is present and empty rather than absent. An unknown
    // sha is a legitimate question and "nothing ADP saw produced this" is the
    // answer — a caller that has to distinguish a missing key from an empty
    // one is a caller doing the schema's job.
    expect(bundle.body).toEqual({
      git_sha: "f".repeat(40),
      change: null,
      gates: [],
      produced_by: { sessions: [], runs: [], proposals: [] },
    });
  });
});
