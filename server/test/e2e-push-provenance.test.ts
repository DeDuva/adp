import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { skipWithoutDb } from "./require-db.js";
import { changes, identities } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerChangeRoutes } from "../src/http-rest/changes.js";
import { registerHookRoutes } from "../src/http-git/hooks.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { repoAccessCheck, findRepo } from "../src/core/repos-lookup.js";

const execFileAsync = promisify(execFile);

// #229 — how a change arrived must not determine the quality of its provenance.
//
// `AuthenticatedIdentity` has carried `harness`, `model` and `sessionId` since
// 1-1. The explicit REST route has always written all three. The push path —
// the one 1b exists to make the *default*, and therefore the only one an agent
// actually takes — wrote none of them, so every ambiently captured change was
// signed with a provenance block that named no harness.
//
// The failure was silent, which is why this file exists and why its central
// test compares the two routes rather than asserting a shape. The block was
// present, signed, and merely thinner — indistinguishable from a human pushing
// without a harness, which is exactly what nobody would go looking for.
describe.skipIf(skipWithoutDb)("#229: provenance is the same whichever route a change arrives by", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let agentToken: string;
  let humanToken: string;
  let identityId: string;
  const owner = `push-prov-owner-${Date.now()}`;
  const session = "8f14e45f-ceea-467a-a3cd-6a3c7b3f1e21";

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-push-prov-"));
    const gitBackend = new GitBackend(gitRoot);
    const signer = new Signer("e2e-push-prov-signing-key");

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerHookRoutes(app, db, gitBackend, signer, "e2e-test-credential-key");
    registerChangeRoutes(app, db, gitBackend, signer);
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    gitBackend.setInternalUrl(`http://127.0.0.1:${port}`);

    const [identity] = await db
      .insert(identities)
      .values({ kind: "agent", principal: `push-prov-e2e-${Date.now()}` })
      .returning();
    identityId = identity!.id;
    // The tuple 1-1 mints a token with. Two tokens for one identity, because
    // the difference under test is the *token's* claim, not the person's.
    agentToken = await mintToken(db, identityId, ["repo:read", "repo:write", "admin"], {
      harness: "claude-code",
      model: "some-model-v1",
      sessionId: session,
    });
    humanToken = await mintToken(db, identityId, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identityId, owner);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  async function createRepo(name: string) {
    const res = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${agentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(201);
  }

  async function pushOne(name: string, token: string, message: string) {
    const dir = await mkdtemp(path.join(tmpdir(), "adp-e2e-push-prov-clone-"));
    const url = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${name}.git`;
    const git = (...args: string[]) => execFileAsync("git", args, { cwd: dir });
    await execFileAsync("git", ["clone", url, dir]);
    await git("checkout", "-B", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await execFileAsync("sh", ["-c", `echo ${Date.now()} > f.txt`], { cwd: dir });
    await git("add", ".");
    await git("commit", "-m", message);
    await git("push", "origin", "main");
    const sha = (await git("rev-parse", "HEAD")).stdout.trim();
    await rm(dir, { recursive: true, force: true });
    // post-receive fires after the client's connection is already closing.
    await new Promise((r) => setTimeout(r, 800));
    return sha;
  }

  async function provenanceOf(repoId: string, sha: string) {
    const [row] = await db
      .select()
      .from(changes)
      .where(and(eq(changes.repoId, repoId), eq(changes.gitSha, sha)));
    return row?.provenance as Record<string, unknown> | undefined;
  }

  it("records harness, model and session_id from a plain git push", async () => {
    const name = "ambient-repo";
    await createRepo(name);
    const sha = await pushOne(name, agentToken, "ambient");
    const repo = (await findRepo(db, owner, name))!;

    expect(await provenanceOf(repo.id, sha)).toMatchObject({
      via: "push",
      harness: "claude-code",
      model: "some-model-v1",
      session_id: session,
    });
  });

  // The invariant, asserted rather than described: the two routes agree, and
  // `via` is the only thing they may disagree about.
  it("produces the same provenance as the explicit REST route, differing only in via", async () => {
    const name = "agreement-repo";
    await createRepo(name);
    const sha = await pushOne(name, agentToken, "agreement");
    const repo = (await findRepo(db, owner, name))!;
    const pushed = await provenanceOf(repo.id, sha)!;

    // The REST route is an upsert since #143, and on an *update* it keeps the
    // provenance already recorded — deliberately, because that names who
    // produced the commit and the second call is a binding rather than a
    // second origin story. So comparing the two routes means giving the REST
    // one a sha with no row behind it, which is the only shape where it writes
    // provenance of its own. Dropping the auto-recorded row is how a test
    // reaches that state; nothing in the product does.
    const other = "agreement-rest-repo";
    await createRepo(other);
    const otherSha = await pushOne(other, humanToken, "for the rest route");
    const otherRepo = (await findRepo(db, owner, other))!;
    await db.delete(changes).where(and(eq(changes.repoId, otherRepo.id), eq(changes.gitSha, otherSha)));

    const res = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${other}/changes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${agentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ git_sha: otherSha }),
    });
    expect(res.status).toBeLessThan(300);
    const viaRest = await provenanceOf(otherRepo.id, otherSha)!;

    const { via: pushedVia, ...pushedRest } = pushed!;
    const { via: restVia, ...restRest } = viaRest!;
    expect(pushedVia).toBe("push");
    expect(restVia).toBeUndefined();
    expect(pushedRest).toEqual(restRest);
  });

  // Absent means absent. A change pushed by a person must not claim a harness,
  // and the fix must not make one up to keep the shapes uniform.
  it("claims no harness for a push from a token that has none", async () => {
    const name = "human-repo";
    await createRepo(name);
    const sha = await pushOne(name, humanToken, "by hand");
    const repo = (await findRepo(db, owner, name))!;

    const provenance = await provenanceOf(repo.id, sha);
    expect(provenance).toMatchObject({ via: "push" });
    expect(provenance).not.toHaveProperty("harness");
    expect(provenance).not.toHaveProperty("model");
    expect(provenance).not.toHaveProperty("session_id");
  });
});
