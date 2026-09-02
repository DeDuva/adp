import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
import { registerProposalRoutes } from "../src/http-rest/proposals.js";
import { registerMirrorWebhookRoutes, registerMirrorWebhookRawBodyParser } from "../src/http-rest/mirror-webhook.js";
import { loadGitHubSchema } from "../src/http-gql/schema.js";
import { attachResolvers } from "../src/http-gql/attach-resolvers.js";
import { createResolvers } from "../src/http-gql/resolvers.js";
import { registerGraphQLRoute } from "../src/http-gql/route.js";
import { toGlobalId } from "../src/http-gql/global-id.js";

const CREDENTIAL_KEY = "e2e-pr-ingest-credential-key";
const SIGNING_KEY = "e2e-pr-ingest-signing-key";
const PUBLIC_URL = "https://adp.example.com";

// #224 — a GitHub pull request becomes a shadow proposal.
//
// The exit criterion this file exists to prove is the one companion mode turns
// on: a pull request opened on a mirrored GitHub repository appears as a
// proposal in ADP with no ADP command run, keeps up with the branch, and
// survives the redelivery GitHub does routinely.
//
// It also pins the half of the numbering decision that is a *refusal*. A shadow
// proposal adopts the upstream number, `proposals` is unique on
// (repo_id, number), and both create paths therefore have to decline — REST and
// GraphQL, because `gh pr create` uses the second one and a guard on only the
// first is a guard the incumbent client walks past.
describe.skipIf(skipWithoutDb)("#224: pull_request ingest", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  const owner = `pr-ingest-owner-${Date.now()}`;

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-pr-ingest-"));
    const gitBackend = new GitBackend(gitRoot);
    const signer = new Signer(SIGNING_KEY);

    app = Fastify({ logger: false });
    registerMirrorWebhookRawBodyParser(app);
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, PUBLIC_URL);
    registerMirrorRoutes(app, db, CREDENTIAL_KEY);
    registerProposalRoutes(app, db, gitBackend, CREDENTIAL_KEY);
    registerMirrorWebhookRoutes(app, db, gitBackend, signer, CREDENTIAL_KEY, PUBLIC_URL);

    const schema = loadGitHubSchema();
    attachResolvers(schema, createResolvers(gitBackend, CREDENTIAL_KEY));
    registerGraphQLRoute(app, schema, db);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `pr-ingest-e2e-${Date.now()}` })
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

  function prPayload(action: string, overrides: Record<string, unknown> = {}) {
    return {
      action,
      pull_request: {
        number: 482,
        title: "Gate the job lease",
        body: "Closes #92.",
        state: "open",
        merged: false,
        draft: false,
        html_url: "https://github.com/upstream-org/upstream-repo/pull/482",
        head: { ref: "fix/92-gate-job-lease", sha: "a".repeat(40) },
        base: { ref: "main" },
        ...overrides,
      },
    };
  }

  async function proposalRow(repoId: string, number: number) {
    const [row] = await db
      .select()
      .from(proposals)
      .where(and(eq(proposals.repoId, repoId), eq(proposals.number, number)));
    return row;
  }

  // The criterion, stated literally: no ADP command is run anywhere in this
  // test. A webhook arrives and a proposal exists.
  it("turns an opened pull request into a shadow proposal carrying its upstream identity", async () => {
    const name = "opened-repo";
    const repo = await createRepo(name);
    const { webhook_secret } = await createMirror(name);

    const res = await deliver(name, webhook_secret, prPayload("opened"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, recorded: "proposal#482", change: "created" });

    const row = await proposalRow(repo.id, 482);
    expect(row).toBeDefined();
    // The number is the upstream one — 5a's numbering decision, so that
    // `gh pr view 482` means one thing on both planes.
    expect(row!.number).toBe(482);
    expect(row!.upstreamNumber).toBe(482);
    expect(row!.upstreamUrl).toBe("https://github.com/upstream-org/upstream-repo/pull/482");
    expect(row!.title).toBe("Gate the job lease");
    expect(row!.headRef).toBe("fix/92-gate-job-lease");
    expect(row!.headSha).toBe("a".repeat(40));
    expect(row!.baseRef).toBe("main");
    expect(row!.state).toBe("open");

    // Recorded as an ordinary proposal.create, distinguished by `via` rather
    // than by a parallel verb — the operations log stays queryable without
    // knowing which plane a proposal arrived on.
    const ops = await db
      .select()
      .from(operations)
      .where(and(eq(operations.repoId, repo.id), eq(operations.verb, "proposal.create")));
    expect(ops).toHaveLength(1);
    expect(ops[0]!.target).toBe(`${owner}/${name}#482`);
    expect(ops[0]!.after).toMatchObject({ via: "mirror-inbound" });
  });

  it("moves head_sha when the branch is synchronised, and reports it as an update", async () => {
    const name = "sync-repo";
    const repo = await createRepo(name);
    const { webhook_secret } = await createMirror(name);

    await deliver(name, webhook_secret, prPayload("opened"));
    const res = await deliver(
      name,
      webhook_secret,
      prPayload("synchronize", { head: { ref: "fix/92-gate-job-lease", sha: "b".repeat(40) } }),
    );
    expect(await res.json()).toMatchObject({ ok: true, recorded: "proposal#482", change: "updated" });

    const row = await proposalRow(repo.id, 482);
    expect(row!.headSha).toBe("b".repeat(40));
    expect(row!.state).toBe("open");
  });

  it("closes the proposal when the pull request is closed without merging", async () => {
    const name = "closed-repo";
    const repo = await createRepo(name);
    const { webhook_secret } = await createMirror(name);

    await deliver(name, webhook_secret, prPayload("opened"));
    await deliver(
      name,
      webhook_secret,
      prPayload("closed", { state: "closed", merged: false, closed_at: "2026-09-02T10:00:00Z" }),
    );

    const row = await proposalRow(repo.id, 482);
    expect(row!.state).toBe("closed");
    expect(row!.closedAt).not.toBeNull();
    expect(row!.mergedAt).toBeNull();

    const ops = await db
      .select()
      .from(operations)
      .where(and(eq(operations.repoId, repo.id), eq(operations.verb, "proposal.close")));
    expect(ops).toHaveLength(1);
  });

  // A merge is `state: "closed"` with `merged: true` beside it, so reading
  // `state` alone records every merge as an abandonment.
  //
  // No `merge_commit_sha` in this payload, so there is nothing for #225's merge
  // recording to act on — which is the case that isolates the state transition
  // from the operation. The `proposal.merge` operation itself, and the three
  // sources it establishes its pre-merge base sha from, are pinned in
  // e2e-merge-ingest.test.ts.
  it("records a merged pull request as merged", async () => {
    const name = "merged-repo";
    const repo = await createRepo(name);
    const { webhook_secret } = await createMirror(name);

    await deliver(name, webhook_secret, prPayload("opened"));
    await deliver(
      name,
      webhook_secret,
      prPayload("closed", {
        state: "closed",
        merged: true,
        merged_at: "2026-09-02T11:00:00Z",
        closed_at: "2026-09-02T11:00:00Z",
      }),
    );

    const row = await proposalRow(repo.id, 482);
    expect(row!.state).toBe("merged");
    expect(row!.mergedAt).not.toBeNull();

    const merges = await db
      .select()
      .from(operations)
      .where(and(eq(operations.repoId, repo.id), eq(operations.verb, "proposal.merge")));
    expect(merges).toHaveLength(0);
  });

  // GitHub redelivers routinely, and it also sends `edited` for changes this
  // row has no column for. Both are the same fact — the row is already right —
  // and neither may append to an append-only log.
  it("is idempotent under redelivery", async () => {
    const name = "redeliver-repo";
    const repo = await createRepo(name);
    const { webhook_secret } = await createMirror(name);

    await deliver(name, webhook_secret, prPayload("opened"));
    const again = await deliver(name, webhook_secret, prPayload("opened"));
    expect(await again.json()).toMatchObject({ ok: true, skipped: "no change" });

    const rows = await db.select().from(proposals).where(eq(proposals.repoId, repo.id));
    expect(rows).toHaveLength(1);

    const ops = await db.select().from(operations).where(eq(operations.repoId, repo.id));
    expect(ops.filter((o) => o.verb.startsWith("proposal."))).toHaveLength(1);
  });

  it("skips an action that describes upstream bookkeeping a proposal has no column for", async () => {
    const name = "unhandled-repo";
    const repo = await createRepo(name);
    const { webhook_secret } = await createMirror(name);

    const res = await deliver(name, webhook_secret, prPayload("labeled"));
    expect(await res.json()).toMatchObject({ ok: true, skipped: "ignored action 'labeled'" });
    expect(await db.select().from(proposals).where(eq(proposals.repoId, repo.id))).toHaveLength(0);
  });

  // The other half of the numbering decision. Both create paths, because
  // `gh pr create` uses GraphQL.
  it("refuses a natively created proposal on a repository that ingests, over REST and GraphQL", async () => {
    const name = "refuse-repo";
    await createRepo(name);
    await createMirror(name);

    const rest = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${name}/pulls`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "native", head: "feature", base: "main" }),
    });
    expect(rest.status).toBe(409);
    const body = (await rest.json()) as { reason: string; remedy: string };
    expect(body.reason).toBe("pull_request_ingest_enabled");
    // A refusal that explains itself (#145): it names what to do instead.
    expect(body.remedy).toContain("open the pull request on GitHub");

    const repoRow = (await db.select().from(proposals).where(eq(proposals.number, -1))).length;
    expect(repoRow).toBe(0);

    const gql = await fetch(`http://127.0.0.1:${port}/api/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query:
          "mutation($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { number } } }",
        variables: {
          input: {
            repositoryId: toGlobalId("Repository", (await createRepoId(name))!),
            title: "native",
            baseRefName: "main",
            headRefName: "feature",
          },
        },
      }),
    });
    const gqlBody = (await gql.json()) as { errors?: { message: string }[] };
    expect(gqlBody.errors?.[0]?.message).toContain("takes its pull requests from its upstream mirror");
  });

  // A proposal that predates the mirror keeps its number. Overwriting it would
  // destroy a record to make room for a mirror of one.
  it("refuses to overwrite a natively created proposal that already holds the number", async () => {
    const name = "collision-repo";
    const repo = await createRepo(name);
    await db.insert(proposals).values({
      repoId: repo.id,
      number: 482,
      title: "native, and older than the mirror",
      headRef: "feature",
      headSha: "c".repeat(40),
      baseRef: "main",
      authorId: (await db.select().from(identities).limit(1))[0]!.id,
    });
    const { webhook_secret } = await createMirror(name);

    const res = await deliver(name, webhook_secret, prPayload("opened"));
    const body = (await res.json()) as { skipped?: string };
    expect(body.skipped).toContain("natively created proposal");

    const row = await proposalRow(repo.id, 482);
    expect(row!.title).toBe("native, and older than the mirror");
    expect(row!.upstreamNumber).toBeNull();
  });

  async function createRepoId(name: string) {
    const res = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${name}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return ((await res.json()) as { id: string }).id;
  }
});
