import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { skipWithoutDb } from "./require-db.js";
import { identities, operations, proposals } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerMirrorRoutes } from "../src/http-rest/mirrors.js";
import { registerOperationRoutes } from "../src/http-rest/operations.js";
import { registerMirrorWebhookRoutes, registerMirrorWebhookRawBodyParser } from "../src/http-rest/mirror-webhook.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { repoAccessCheck } from "../src/core/repos-lookup.js";

const execFileAsync = promisify(execFile);
const CREDENTIAL_KEY = "e2e-merge-ingest-credential-key";
const SIGNING_KEY = "e2e-merge-ingest-signing-key";
const PUBLIC_URL = "https://adp.example.com";

// #225 — a pull request merged on GitHub writes a real `proposal.merge`.
//
// This is the item that makes 5a's exit criterion reachable: "a developer runs
// the whole loop on GitHub, types no ADP command, and afterwards `adp undo
// <sha>` works". `undo.ts` resolves a `proposal.merge` operation and reads
// `after.mergedInto`, `after.baseSha` and `before.baseSha` off it. The first
// two are in the webhook payload; the third is not, and it is the one the
// compensating revert computes against.
//
// So most of this file is about that third value. A guessed pre-merge base sha
// would make undo run, succeed, and take out the wrong range — worse than the
// refusal #225 exists to remove. Each case below pins one source, and the last
// pins the refusal for the case where there is no fact to be had.
describe.skipIf(skipWithoutDb)("#225: merge ingest", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  const owner = `merge-ingest-owner-${Date.now()}`;

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-merge-ingest-"));
    const gitBackend = new GitBackend(gitRoot);
    const signer = new Signer(SIGNING_KEY);

    app = Fastify({ logger: false });
    registerMirrorWebhookRawBodyParser(app);
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, PUBLIC_URL);
    registerMirrorRoutes(app, db, CREDENTIAL_KEY);
    registerOperationRoutes(app, db, gitBackend);
    registerMirrorWebhookRoutes(app, db, gitBackend, signer, CREDENTIAL_KEY, PUBLIC_URL);
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `merge-ingest-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  async function createRepo(name: string) {
    const res = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  }

  async function createMirror(name: string) {
    const res = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${name}/mirror`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        remote_url: "https://github.com/upstream-org/upstream-repo.git",
        direction: "inbound",
        credential: "upstream-pat",
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { webhook_secret: string };
  }

  function deliver(name: string, secret: string, payload: unknown) {
    const body = JSON.stringify(payload);
    return fetch(`http://127.0.0.1:${port}/webhooks/github/${owner}/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request",
        "X-Hub-Signature-256": "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
      },
      body,
    });
  }

  function mergedPayload(over: { mergeCommitSha: string; headSha: string; parents?: number }) {
    return {
      action: "closed",
      pull_request: {
        number: 482,
        title: "Gate the job lease",
        body: "Closes #92.",
        state: "closed",
        merged: true,
        merged_at: "2026-09-02T11:00:00Z",
        closed_at: "2026-09-02T11:00:00Z",
        html_url: "https://github.com/upstream-org/upstream-repo/pull/482",
        merge_commit_sha: over.mergeCommitSha,
        head: { ref: "fix/92-gate-job-lease", sha: over.headSha },
        base: { ref: "main" },
      },
    };
  }

  function openedPayload(headSha: string) {
    return {
      action: "opened",
      pull_request: {
        number: 482,
        title: "Gate the job lease",
        body: "Closes #92.",
        state: "open",
        merged: false,
        html_url: "https://github.com/upstream-org/upstream-repo/pull/482",
        head: { ref: "fix/92-gate-job-lease", sha: headSha },
        base: { ref: "main" },
      },
    };
  }

  // A real repository, because everything under test reads real git objects.
  // Returns the shas the cases assert against.
  async function seedRepo(name: string, shape: "merge" | "linear") {
    const repo = await createRepo(name);
    const dir = await mkdtemp(path.join(tmpdir(), "adp-e2e-merge-clone-"));
    const url = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${name}.git`;
    const git = (...args: string[]) => execFileAsync("git", args, { cwd: dir });

    await execFileAsync("git", ["clone", url, dir]);
    await git("checkout", "-B", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await execFileAsync("sh", ["-c", "echo base > README.md"], { cwd: dir });
    await git("add", ".");
    await git("commit", "-m", "base");
    await git("push", "origin", "main");
    const baseSha = (await git("rev-parse", "HEAD")).stdout.trim();

    await git("checkout", "-b", "fix/92-gate-job-lease");
    await execFileAsync("sh", ["-c", "echo work > lease.md"], { cwd: dir });
    await git("add", ".");
    await git("commit", "-m", "gate the lease");
    const headSha = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("push", "origin", "fix/92-gate-job-lease");

    await git("checkout", "main");
    if (shape === "merge") {
      // --no-ff, so the merge commit has the two parents GitHub's default
      // merge button produces.
      await git("merge", "--no-ff", "fix/92-gate-job-lease", "-m", "Merge pull request #482");
    } else {
      // One parent, which is what squash and rebase both leave behind.
      await git("merge", "--ff-only", "fix/92-gate-job-lease");
    }
    const mergeSha = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("push", "origin", "main");

    await rm(dir, { recursive: true, force: true });
    return { repoId: repo.id, baseSha, headSha, mergeSha };
  }

  async function mergeOp(repoId: string) {
    const [row] = await db
      .select()
      .from(operations)
      .where(and(eq(operations.repoId, repoId), eq(operations.verb, "proposal.merge")));
    return row;
  }

  // The definitional case: a merge commit's first parent *is* the base tip it
  // was made on, so nothing has to be inferred.
  it("takes the pre-merge base from the merge commit's first parent, and undo then reaches it", async () => {
    const name = "merge-parent-repo";
    const shas = await seedRepo(name, "merge");
    const { webhook_secret } = await createMirror(name);

    await deliver(name, webhook_secret, openedPayload(shas.headSha));
    const res = await deliver(name, webhook_secret, mergedPayload({ mergeCommitSha: shas.mergeSha, headSha: shas.headSha }));
    expect(await res.json()).toMatchObject({ ok: true, merge: "recorded" });

    const op = await mergeOp(shas.repoId);
    expect(op).toBeDefined();
    expect(op!.before).toMatchObject({ baseSha: shas.baseSha });
    expect(op!.after).toMatchObject({
      baseSha: shas.mergeSha,
      mergedInto: "main",
      mergeMethod: "upstream",
      baseShaSource: "parent",
    });

    // 5a's exit criterion, in miniature: no ADP command produced any of this,
    // and `adp undo` reaches it. `main` still points where the merge left it,
    // so this is the exact path — the branch winds back rather than a revert
    // being proposed.
    const undone = await fetch(
      `http://127.0.0.1:${port}/api/adp/repos/${owner}/${name}/operations/${op!.id}/undo`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    );
    expect(undone.status).toBe(200);
    expect((await undone.json()) as { undo_path: string }).toMatchObject({ undo_path: "rollback" });

    const backend = new GitBackend(gitRoot);
    expect(await backend.resolveRef(owner, name, "main")).toBe(shas.baseSha);
  });

  // The ordering case, and the common one: `pull_request` arrives before the
  // `push` that carries the merge, so the base ref here still points where it
  // pointed before and the answer can simply be read.
  it("reads the pre-merge base off the base ref when the merge has not reached this instance yet", async () => {
    const name = "merge-ref-repo";
    const shas = await seedRepo(name, "linear");
    const { webhook_secret } = await createMirror(name);

    // A merge commit this instance has never seen. Nothing resolves it, so the
    // parent source cannot answer and the ref source must.
    const unseen = "d".repeat(40);
    await deliver(name, webhook_secret, openedPayload(shas.headSha));
    const res = await deliver(name, webhook_secret, mergedPayload({ mergeCommitSha: unseen, headSha: shas.headSha }));
    expect(await res.json()).toMatchObject({ merge: "recorded" });

    const op = await mergeOp(shas.repoId);
    expect(op!.before).toMatchObject({ baseSha: shas.mergeSha });
    expect(op!.after).toMatchObject({ baseSha: unseen, baseShaSource: "ref" });
  });

  // The case with no fact available: one parent, and the branch here already
  // contains the merge, so neither source knows where it was. A squash leaves
  // the pre-merge tip at `merge~1` and a rebase of n commits leaves it at
  // `merge~n`, and the payload does not say which happened — so nothing is
  // recorded, and `adp undo` refuses because there is no merge rather than
  // because a recorded one is unusable.
  it("declines to record a merge whose pre-merge base cannot be established", async () => {
    const name = "merge-unknown-repo";
    const shas = await seedRepo(name, "linear");
    const { webhook_secret } = await createMirror(name);

    await deliver(name, webhook_secret, openedPayload(shas.headSha));
    const res = await deliver(name, webhook_secret, mergedPayload({ mergeCommitSha: shas.mergeSha, headSha: shas.headSha }));
    expect(await res.json()).toMatchObject({ merge: "merge_base_unknown" });

    const [proposal] = await db
      .select()
      .from(proposals)
      .where(and(eq(proposals.repoId, shas.repoId), eq(proposals.number, 482)));
    // The row is still truthful about the merge — only the operation is absent.
    expect(proposal!.state).toBe("merged");
    expect(await mergeOp(shas.repoId)).toBeUndefined();
  });

  it("records exactly one merge however often GitHub redelivers the event", async () => {
    const name = "merge-redeliver-repo";
    const shas = await seedRepo(name, "merge");
    const { webhook_secret } = await createMirror(name);

    await deliver(name, webhook_secret, openedPayload(shas.headSha));
    await deliver(name, webhook_secret, mergedPayload({ mergeCommitSha: shas.mergeSha, headSha: shas.headSha }));
    const again = await deliver(name, webhook_secret, mergedPayload({ mergeCommitSha: shas.mergeSha, headSha: shas.headSha }));
    expect(await again.json()).toMatchObject({ merge: "already-recorded" });

    const rows = await db
      .select()
      .from(operations)
      .where(and(eq(operations.repoId, shas.repoId), eq(operations.verb, "proposal.merge")));
    expect(rows).toHaveLength(1);
  });
});
