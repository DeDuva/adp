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
import { changes, identities, operations } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { repoAccessCheck, findRepo } from "../src/core/repos-lookup.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerHookRoutes } from "../src/http-git/hooks.js";
import { registerChangeRoutes } from "../src/http-rest/changes.js";
import { registerIssueRoutes } from "../src/http-rest/issues.js";
import { registerEvidenceRoutes } from "../src/http-rest/evidence.js";

const execFileAsync = promisify(execFile);

// #143: the documented way to record an intent-bound change is "push, then
// POST /changes". Until this landed that sequence produced *two* rows for one
// sha — the push's auto-recorded, unbound one (#142) and the explicit, bound
// one — because the route inserted unconditionally and (repo_id, git_sha) was
// indexed rather than unique. `getEvidenceBundle` then read them with no
// ORDER BY and no LIMIT, so whether the evidence bundle showed the intent at
// all was not pinned by the code.
//
// Everything here drives that sequence through the real `git` binary and the
// real hook path, because the duplicate only exists when both writers have
// run.
describe.skipIf(skipWithoutDb)("#143: one change row per sha, and a deterministic evidence read", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  let identityId: string;
  let signer: Signer;
  let repoId: string;
  let sha: string;
  const owner = `bind-owner-${Date.now()}`;
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
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }

  async function newIntent(title: string): Promise<string> {
    const res = await api(`/api/v3/repos/${owner}/${repoName}/issues`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    return res.body!.intent_id as string;
  }

  async function rowsForSha() {
    return db.select().from(changes).where(and(eq(changes.repoId, repoId), eq(changes.gitSha, sha)));
  }

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-bind-git-"));
    const gitBackend = new GitBackend(gitRoot);
    signer = new Signer("e2e-bind-signing-key");

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerIssueRoutes(app, db);
    registerHookRoutes(app, db, gitBackend, signer, "e2e-test-credential-key");
    registerChangeRoutes(app, db, gitBackend, signer);
    registerEvidenceRoutes(app, db);
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;
    gitBackend.setInternalUrl(`http://127.0.0.1:${port}`);

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `bind-e2e-${Date.now()}` })
      .returning();
    identityId = identity!.id;
    token = await mintToken(db, identityId, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identityId, owner);

    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: repoName }) });
    repoId = (await findRepo(db, owner, repoName))!.id;

    // A push with no intent trailer, so the auto-recorded row is unbound —
    // which is the state the explicit POST exists to complete.
    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-bind-clone-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo hi > README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "no trailer here"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    sha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: cloneDir })).stdout.trim();
    await rm(cloneDir, { recursive: true, force: true });

    // post-receive fires after the client's connection would already be
    // closing, so the push returning is not the record existing.
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("push, then POST /changes: exactly one row, bound, and signed over the binding", async () => {
    const before = await rowsForSha();
    expect(before).toHaveLength(1);
    expect(before[0]!.intentId).toBeNull();
    const pushedId = before[0]!.id;
    const pushedProvenance = before[0]!.provenance;

    const intentId = await newIntent("bind me");
    const res = await api(`/api/v3/repos/${owner}/${repoName}/changes`, {
      method: "POST",
      body: JSON.stringify({ git_sha: sha, intent_id: intentId }),
    });
    expect(res.status).toBe(201);

    // The row the push recorded, completed — not a sibling beside it.
    const after = await rowsForSha();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(pushedId);
    expect(after[0]!.intentId).toBe(intentId);

    // Provenance stays the push's: it names what produced the commit, and
    // this call is a binding rather than a second origin story.
    expect(after[0]!.provenance).toEqual(pushedProvenance);
    expect((after[0]!.provenance as { via: string }).via).toBe("push");

    // Re-signed rather than merely re-stored: the signature covers intent_id,
    // so the old signature — over a null intent — must no longer verify.
    expect(after[0]!.signature).not.toBe(before[0]!.signature);
    expect(
      signer.verify(
        { repo: `${owner}/${repoName}`, git_sha: sha, intent_id: intentId, provenance: after[0]!.provenance },
        after[0]!.signature,
      ),
    ).toBe(true);
    expect(
      signer.verify(
        { repo: `${owner}/${repoName}`, git_sha: sha, intent_id: null, provenance: after[0]!.provenance },
        after[0]!.signature,
      ),
    ).toBe(false);

    // The update is in the operation log, like the create already was — the
    // append-only spine covers every write path, not the convenient ones.
    const [op] = await db
      .select()
      .from(operations)
      .where(and(eq(operations.verb, "change.update"), eq(operations.target, `${owner}/${repoName}@${sha}`)));
    expect(op).toBeTruthy();
    expect(op!.actorId).toBe(identityId);
    expect((op!.before as { intentId: string | null }).intentId).toBeNull();
    expect((op!.after as { intentId: string }).intentId).toBe(intentId);
  });

  // The assertion that would have been a coin flip before this landed: with
  // two rows for the sha, one bound and one not, the unordered read could
  // legitimately return either — so the bundle either showed the intent or
  // did not, and nothing in the code said which.
  it("the evidence bundle names that intent, deterministically", async () => {
    const [row] = await rowsForSha();
    const bundle = await api(`/api/adp/repos/${owner}/${repoName}/evidence/${sha}`);
    expect(bundle.status).toBe(200);
    const change = bundle.body!.change as { id: string; intent_id: string | null };
    expect(change.id).toBe(row!.id);
    expect(change.intent_id).toBe(row!.intentId);
    expect(change.intent_id).not.toBeNull();
  });

  it("re-posting the same binding is a no-op success, not a second row", async () => {
    const [before] = await rowsForSha();
    const res = await api(`/api/v3/repos/${owner}/${repoName}/changes`, {
      method: "POST",
      body: JSON.stringify({ git_sha: sha, intent_id: before!.intentId }),
    });
    expect(res.status).toBe(201);

    const after = await rowsForSha();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before!.id);
    expect(after[0]!.signature).toBe(before!.signature);
  });

  // Rebinding is a claim about the past. Refusing it is the whole reason the
  // upsert fills a null rather than overwriting: a change whose intent moved
  // would carry a valid signature over each of two contradictory statements.
  it("refuses to rebind a sha already bound to a different intent, and changes nothing", async () => {
    const [before] = await rowsForSha();
    const other = await newIntent("a different story");

    const res = await api(`/api/v3/repos/${owner}/${repoName}/changes`, {
      method: "POST",
      body: JSON.stringify({ git_sha: sha, intent_id: other }),
    });
    expect(res.status).toBe(409);
    expect(res.body!.message as string).toContain(before!.intentId!);

    const after = await rowsForSha();
    expect(after).toHaveLength(1);
    expect(after[0]!.intentId).toBe(before!.intentId);
    expect(after[0]!.signature).toBe(before!.signature);
  });

  it("a commit the push path never saw is still created by the explicit route", async () => {
    // Written straight into the bare repo, so no hook fires and no row exists.
    const repoPath = new GitBackend(gitRoot).repoPath(owner, repoName);
    const git = (args: string[]) =>
      execFileAsync("git", ["-C", repoPath, ...args], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
      });
    const { stdout: tree } = await git(["hash-object", "-w", "-t", "tree", "/dev/null"]);
    const { stdout: commit } = await git(["commit-tree", tree.trim(), "-m", "never pushed"]);
    const unpushed = commit.trim();

    const intentId = await newIntent("created outright");
    const res = await api(`/api/v3/repos/${owner}/${repoName}/changes`, {
      method: "POST",
      body: JSON.stringify({ git_sha: unpushed, intent_id: intentId }),
    });
    expect(res.status).toBe(201);

    const rows = await db.select().from(changes).where(and(eq(changes.repoId, repoId), eq(changes.gitSha, unpushed)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.intentId).toBe(intentId);
    // No push produced it, so the provenance is this caller's.
    expect((rows[0]!.provenance as { via?: string }).via).toBeUndefined();
    expect((rows[0]!.provenance as { principal: string }).principal).toContain("bind-e2e-");
  });
});
