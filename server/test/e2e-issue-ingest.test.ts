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
import { changes, identities, intents, issues, operations } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerIssueRoutes } from "../src/http-rest/issues.js";
import { registerMirrorRoutes } from "../src/http-rest/mirrors.js";
import { registerEvidenceRoutes } from "../src/http-rest/evidence.js";
import { registerHookRoutes } from "../src/http-git/hooks.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { registerMirrorWebhookRoutes, registerMirrorWebhookRawBodyParser } from "../src/http-rest/mirror-webhook.js";
import { repoAccessCheck, findRepo } from "../src/core/repos-lookup.js";

const execFileAsync = promisify(execFile);
const CREDENTIAL_KEY = "e2e-issue-ingest-credential-key";
const SIGNING_KEY = "e2e-issue-ingest-signing-key";

// #226 — a GitHub issue becomes an intent that says which issue it is.
//
// `intents.source` already distinguished `issue` from `api` and stopped there,
// so a team organising work in GitHub Issues got an ADP intent universe beside
// theirs rather than under it. Two rows are written now, exactly as the native
// create path writes two: the intent, and the issue row that is the compat
// projection.
//
// The issue row is not bookkeeping. `resolveTrailers` binds `ADP-Intent: #92`
// by looking up issue 92 and taking its intent, and in companion mode #92 is a
// GitHub issue number — so without it, the trailer a developer actually writes
// resolves to nothing. The second test is that whole path, ending at the
// evidence bundle naming the GitHub issue by title, which is 5a's exit
// criterion.
describe.skipIf(skipWithoutDb)("#226: issues ingest", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  const owner = `issue-ingest-owner-${Date.now()}`;

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-issue-ingest-"));
    const gitBackend = new GitBackend(gitRoot);
    const signer = new Signer(SIGNING_KEY);

    app = Fastify({ logger: false });
    registerMirrorWebhookRawBodyParser(app);
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerIssueRoutes(app, db);
    registerMirrorRoutes(app, db, CREDENTIAL_KEY);
    registerEvidenceRoutes(app, db);
    registerHookRoutes(app, db, gitBackend, signer, CREDENTIAL_KEY);
    registerMirrorWebhookRoutes(app, db, gitBackend, signer, CREDENTIAL_KEY, "https://adp.example.com");
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    gitBackend.setInternalUrl(`http://127.0.0.1:${port}`);

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `issue-ingest-e2e-${Date.now()}` })
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

  function deliver(name: string, secret: string, payload: unknown, event = "issues") {
    const body = JSON.stringify(payload);
    return fetch(`http://127.0.0.1:${port}/webhooks/github/${owner}/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": event,
        "X-Hub-Signature-256": "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
      },
      body,
    });
  }

  function issuePayload(action: string, over: Record<string, unknown> = {}) {
    return {
      action,
      issue: {
        number: 92,
        title: "Gate job lease is not enforced",
        body: "A claimed job whose runner dies is never reclaimed.",
        state: "open",
        html_url: "https://github.com/upstream-org/upstream-repo/issues/92",
        ...over,
      },
      repository: { html_url: "https://github.com/upstream-org/upstream-repo" },
    };
  }

  it("files an intent that says which issue it is, and on whose host", async () => {
    const name = "issue-opened-repo";
    const repo = await createRepo(name);
    const { webhook_secret } = await createMirror(name);

    const res = await deliver(name, webhook_secret, issuePayload("opened"));
    expect(await res.json()).toMatchObject({ ok: true, recorded: "issue#92", change: "created" });

    const [intent] = await db.select().from(intents).where(eq(intents.repoId, repo.id));
    expect(intent!.source).toBe("issue");
    expect(intent!.title).toBe("Gate job lease is not enforced");
    // The identity half. "Issue 92" means nothing without saying whose 92 —
    // which is the fact 5-16 has to carry to another instance intact.
    expect(intent!.upstreamHost).toBe("github.com");
    expect(intent!.upstreamNumber).toBe(92);
    expect(intent!.upstreamUrl).toBe("https://github.com/upstream-org/upstream-repo/issues/92");

    // The compat projection, on the upstream number.
    const [issue] = await db.select().from(issues).where(eq(issues.repoId, repo.id));
    expect(issue!.number).toBe(92);
    expect(issue!.intentId).toBe(intent!.id);

    const ops = await db
      .select()
      .from(operations)
      .where(and(eq(operations.repoId, repo.id), eq(operations.verb, "issue.create")));
    expect(ops).toHaveLength(1);
    expect(ops[0]!.after).toMatchObject({ via: "mirror-inbound", upstreamHost: "github.com" });
  });

  // 5a's exit criterion, end to end and with no ADP command in it: a GitHub
  // issue, a plain `git push` whose commit names it the way a developer
  // actually writes it, and an evidence bundle that names the issue by title.
  it("binds a pushed commit to the ingested issue by its GitHub number, and the evidence bundle names it", async () => {
    const name = "issue-trailer-repo";
    await createRepo(name);
    const { webhook_secret } = await createMirror(name);
    await deliver(name, webhook_secret, issuePayload("opened"));

    const dir = await mkdtemp(path.join(tmpdir(), "adp-e2e-issue-clone-"));
    const url = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${name}.git`;
    const git = (...args: string[]) => execFileAsync("git", args, { cwd: dir });
    await execFileAsync("git", ["clone", url, dir]);
    await git("checkout", "-B", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await execFileAsync("sh", ["-c", "echo lease > lease.md"], { cwd: dir });
    await git("add", ".");
    // The trailer names the *GitHub* issue number, which is the whole point:
    // in companion mode that is the only number the developer has ever seen.
    await git("commit", "-m", "Reclaim an expired lease\n\nADP-Intent: #92");
    await git("push", "origin", "main");
    const sha = (await git("rev-parse", "HEAD")).stdout.trim();
    await rm(dir, { recursive: true, force: true });

    // post-receive fires after the push's connection is already closing.
    await new Promise((resolve) => setTimeout(resolve, 800));

    const repoRow = (await findRepo(db, owner, name))!;
    const [change] = await db
      .select()
      .from(changes)
      .where(and(eq(changes.repoId, repoRow.id), eq(changes.gitSha, sha)));
    expect(change).toBeDefined();
    expect(change!.intentId).not.toBeNull();

    const bundle = await fetch(
      `http://127.0.0.1:${port}/api/adp/repos/${owner}/${name}/evidence/${sha}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(bundle.status).toBe(200);
    const body = (await bundle.json()) as {
      change: { intent: { title: string; issue_number: number | null; upstream_url: string | null } | null };
    };
    expect(body.change.intent).toMatchObject({
      title: "Gate job lease is not enforced",
      issue_number: 92,
      // Navigable off this instance, which a number in a per-repo sequence is
      // not.
      upstream_url: "https://github.com/upstream-org/upstream-repo/issues/92",
    });
  });

  it("carries an edit onto both rows, and a close onto the issue only", async () => {
    const name = "issue-edit-repo";
    const repo = await createRepo(name);
    const { webhook_secret } = await createMirror(name);
    await deliver(name, webhook_secret, issuePayload("opened"));

    await deliver(name, webhook_secret, issuePayload("edited", { title: "Gate job lease expires without a reaper" }));
    const [intentAfterEdit] = await db.select().from(intents).where(eq(intents.repoId, repo.id));
    expect(intentAfterEdit!.title).toBe("Gate job lease expires without a reaper");

    await deliver(
      name,
      webhook_secret,
      issuePayload("closed", {
        title: "Gate job lease expires without a reaper",
        state: "closed",
        closed_at: "2026-09-02T12:00:00Z",
      }),
    );
    const [issue] = await db.select().from(issues).where(eq(issues.repoId, repo.id));
    expect(issue!.state).toBe("closed");
    expect(issue!.closedAt).not.toBeNull();

    // An intent has no state, deliberately: what was wanted does not stop
    // being true because the issue asking for it was closed.
    const [intent] = await db.select().from(intents).where(eq(intents.repoId, repo.id));
    expect(intent!.title).toBe("Gate job lease expires without a reaper");

    const ops = await db
      .select()
      .from(operations)
      .where(and(eq(operations.repoId, repo.id), eq(operations.verb, "issue.close")));
    expect(ops).toHaveLength(1);
  });

  // Upstream a pull request is an issue, and GitHub delivers `issues` events
  // for it. Here they are different objects, and ingesting one twice would
  // give a single piece of work two intents.
  it("skips a pull request delivered over the issues event", async () => {
    const name = "issue-pr-repo";
    const repo = await createRepo(name);
    const { webhook_secret } = await createMirror(name);

    const res = await deliver(
      name,
      webhook_secret,
      issuePayload("opened", { pull_request: { url: "https://api.github.com/…/pulls/92" } }),
    );
    expect((await res.json()) as { skipped: string }).toMatchObject({
      skipped: "pull request delivered as an issue — handled by pull_request ingest",
    });
    expect(await db.select().from(intents).where(eq(intents.repoId, repo.id))).toHaveLength(0);
  });

  it("is idempotent under redelivery", async () => {
    const name = "issue-redeliver-repo";
    const repo = await createRepo(name);
    const { webhook_secret } = await createMirror(name);

    await deliver(name, webhook_secret, issuePayload("opened"));
    const again = await deliver(name, webhook_secret, issuePayload("opened"));
    expect(await again.json()).toMatchObject({ skipped: "no change" });

    expect(await db.select().from(intents).where(eq(intents.repoId, repo.id))).toHaveLength(1);
    expect(await db.select().from(issues).where(eq(issues.repoId, repo.id))).toHaveLength(1);
  });

  it("refuses a natively filed issue on a repository that ingests", async () => {
    const name = "issue-refuse-repo";
    await createRepo(name);
    await createMirror(name);

    const res = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${name}/issues`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "filed here" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { reason: string; remedy: string };
    expect(body.reason).toBe("issue_ingest_enabled");
    expect(body.remedy).toContain("file the issue on GitHub");
  });

  it("refuses to overwrite an issue that predates the mirror", async () => {
    const name = "issue-collision-repo";
    await createRepo(name);

    // Filed natively, before the mirror existed — so it is not a shadow of
    // anything and its number is its own.
    const created = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${name}/issues`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "filed here, before the mirror" }),
    });
    expect(created.status).toBe(201);
    const native = (await created.json()) as { number: number };

    const { webhook_secret } = await createMirror(name);
    const res = await deliver(name, webhook_secret, issuePayload("opened", { number: native.number }));
    expect((await res.json()) as { skipped?: string }).toMatchObject({
      skipped: expect.stringContaining("natively filed issue"),
    });

    const repoRow = (await findRepo(db, owner, name))!;
    const [issue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.repoId, repoRow.id), eq(issues.number, native.number)));
    expect(issue!.title).toBe("filed here, before the mirror");
  });
});
