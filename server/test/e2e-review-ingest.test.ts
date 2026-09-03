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
import { identities, proposals, reviews } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerMirrorRoutes } from "../src/http-rest/mirrors.js";
import { registerMirrorWebhookRoutes, registerMirrorWebhookRawBodyParser } from "../src/http-rest/mirror-webhook.js";
import { evaluateLandPolicy } from "../src/core/land-policy.js";

const CREDENTIAL_KEY = "e2e-review-ingest-credential-key";

// #227 — a GitHub approval satisfies `one_approval`.
//
// The requirement is author-independent by construction (#121), so this only
// works because #230 landed first: while every ingested row was attributed to
// the mirror's system identity, the approver and the proposal author were the
// same identity and no mirrored pull request could ever be approved.
//
// Two behaviours are pinned here beyond "an approval counts". A reviewer's
// *current* verdict is what counts, not every verdict they have held — which
// ingest turns from a corner case into the ordinary shape of review on GitHub.
// And a dismissed approval stops counting while the review itself is kept,
// because an approval that was withdrawn is a different fact from one that was
// never given.
describe.skipIf(skipWithoutDb)("#227: pull_request_review ingest", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitBackend: GitBackend;
  let gitRoot: string;
  let port: number;
  let token: string;
  const owner = `review-ingest-owner-${Date.now()}`;
  const run = Date.now();
  const login = (n: string) => `${n}-${run}`;
  let nextId = run % 1_000_000;
  const uid = () => ++nextId;

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-review-ingest-"));
    gitBackend = new GitBackend(gitRoot);

    app = Fastify({ logger: false });
    registerMirrorWebhookRawBodyParser(app);
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerMirrorRoutes(app, db, CREDENTIAL_KEY);
    registerMirrorWebhookRoutes(app, db, gitBackend, new Signer("k"), CREDENTIAL_KEY, "https://adp.example.com");

    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `review-ingest-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  async function seed(name: string, authorLogin: string, authorId: number) {
    const created = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(created.status).toBe(201);
    const repo = (await created.json()) as { id: string };

    const mirrored = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${name}/mirror`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        remote_url: "https://github.com/upstream-org/upstream-repo.git",
        direction: "inbound",
        credential: "upstream-pat",
      }),
    });
    expect(mirrored.status).toBe(201);
    const { webhook_secret } = (await mirrored.json()) as { webhook_secret: string };

    await deliver(name, webhook_secret, "pull_request", {
      action: "opened",
      pull_request: {
        number: 482,
        title: "Gate the job lease",
        state: "open",
        html_url: "https://github.com/upstream-org/upstream-repo/pull/482",
        head: { ref: "fix/92", sha: "a".repeat(40) },
        base: { ref: "main" },
        user: { id: authorId, login: authorLogin, type: "User" },
      },
    });
    return { repo, webhook_secret };
  }

  function deliver(name: string, secret: string, event: string, payload: unknown) {
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

  function reviewPayload(over: {
    id: number;
    state: string;
    login: string;
    userId: number;
    action?: string;
    submitted_at?: string;
  }) {
    return {
      action: over.action ?? "submitted",
      review: {
        id: over.id,
        state: over.state,
        body: "",
        submitted_at: over.submitted_at ?? "2026-09-02T10:00:00Z",
        user: { id: over.userId, login: over.login, type: "User" },
      },
      pull_request: { number: 482 },
    };
  }

  async function oneApproval(repoId: string, name: string) {
    const [proposal] = await db.select().from(proposals).where(eq(proposals.repoId, repoId));
    return evaluateLandPolicy(
      db,
      gitBackend,
      ["one_approval"],
      { id: repoId, owner, name },
      {
        id: proposal!.id,
        number: proposal!.number,
        baseRef: proposal!.baseRef,
        headSha: proposal!.headSha,
        authorId: proposal!.authorId,
      },
    );
  }

  // The item, stated plainly. Before #230 this could not pass: the approver and
  // the proposal author were the same system identity.
  it("lets a GitHub approval satisfy one_approval, from someone other than the author", async () => {
    const name = "approval-repo";
    const author = login("author");
    const reviewer = login("reviewer");
    const { repo, webhook_secret } = await seed(name, author, uid());

    const before = await oneApproval(repo.id, name);
    expect(before.allowed).toBe(false);
    expect(before.unmet[0]!.requirement).toBe("one_approval");

    const res = await deliver(
      name,
      webhook_secret,
      "pull_request_review",
      reviewPayload({ id: 9001, state: "approved", login: reviewer, userId: uid() }),
    );
    expect(await res.json()).toMatchObject({ ok: true, recorded: "review:approved" });

    const after = await oneApproval(repo.id, name);
    expect(after.allowed).toBe(true);
  });

  // GitHub refuses self-approval outright, so this can only arise if the record
  // says something GitHub would not have allowed. It still must not count —
  // the requirement that binds self-attestation cannot be weaker than the
  // incumbent's (#121).
  it("does not let the pull request's own author approve it", async () => {
    const name = "self-approval-repo";
    const author = login("selfauthor");
    const authorId = uid();
    const { repo, webhook_secret } = await seed(name, author, authorId);

    await deliver(
      name,
      webhook_secret,
      "pull_request_review",
      reviewPayload({ id: 9101, state: "approved", login: author, userId: authorId }),
    );

    const verdict = await oneApproval(repo.id, name);
    expect(verdict.allowed).toBe(false);
    expect(verdict.unmet[0]!.problem).toContain("the proposal author's own");
  });

  // The ordinary shape of review on GitHub: approve, the branch moves, ask for
  // changes. The approval is no longer that reviewer's opinion.
  it("counts a reviewer's current verdict, not every verdict they have held", async () => {
    const name = "supersede-repo";
    const reviewer = login("changesreviewer");
    const reviewerId = uid();
    const { repo, webhook_secret } = await seed(name, login("author2"), uid());

    await deliver(
      name,
      webhook_secret,
      "pull_request_review",
      reviewPayload({ id: 9201, state: "approved", login: reviewer, userId: reviewerId, submitted_at: "2026-09-02T10:00:00Z" }),
    );
    expect((await oneApproval(repo.id, name)).allowed).toBe(true);

    await deliver(
      name,
      webhook_secret,
      "pull_request_review",
      reviewPayload({
        id: 9202,
        state: "changes_requested",
        login: reviewer,
        userId: reviewerId,
        submitted_at: "2026-09-02T11:00:00Z",
      }),
    );
    expect((await oneApproval(repo.id, name)).allowed).toBe(false);

    // A comment is not a verdict, and must not displace the one it was left
    // beside.
    await deliver(
      name,
      webhook_secret,
      "pull_request_review",
      reviewPayload({
        id: 9203,
        state: "approved",
        login: reviewer,
        userId: reviewerId,
        submitted_at: "2026-09-02T12:00:00Z",
      }),
    );
    await deliver(
      name,
      webhook_secret,
      "pull_request_review",
      reviewPayload({
        id: 9204,
        state: "commented",
        login: reviewer,
        userId: reviewerId,
        submitted_at: "2026-09-02T13:00:00Z",
      }),
    );
    expect((await oneApproval(repo.id, name)).allowed).toBe(true);
  });

  it("stops counting a dismissed approval, and keeps the review", async () => {
    const name = "dismiss-repo";
    const reviewer = login("dismissreviewer");
    const reviewerId = uid();
    const { repo, webhook_secret } = await seed(name, login("author3"), uid());

    await deliver(
      name,
      webhook_secret,
      "pull_request_review",
      reviewPayload({ id: 9301, state: "approved", login: reviewer, userId: reviewerId }),
    );
    expect((await oneApproval(repo.id, name)).allowed).toBe(true);

    await deliver(
      name,
      webhook_secret,
      "pull_request_review",
      reviewPayload({ id: 9301, state: "dismissed", login: reviewer, userId: reviewerId, action: "dismissed" }),
    );
    expect((await oneApproval(repo.id, name)).allowed).toBe(false);

    // Kept, not deleted: an approval that was withdrawn is a different fact
    // from one that was never given.
    const [proposal] = await db.select().from(proposals).where(eq(proposals.repoId, repo.id));
    const rows = await db.select().from(reviews).where(eq(reviews.proposalId, proposal!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("approved");
    expect(rows[0]!.dismissedAt).not.toBeNull();
  });

  it("is idempotent under redelivery", async () => {
    const name = "review-redeliver-repo";
    const reviewer = login("redeliverreviewer");
    const reviewerId = uid();
    const { repo, webhook_secret } = await seed(name, login("author4"), uid());

    const payload = reviewPayload({ id: 9401, state: "approved", login: reviewer, userId: reviewerId });
    await deliver(name, webhook_secret, "pull_request_review", payload);
    const again = await deliver(name, webhook_secret, "pull_request_review", payload);
    expect(await again.json()).toMatchObject({ skipped: "no change" });

    const [proposal] = await db.select().from(proposals).where(eq(proposals.repoId, repo.id));
    expect(await db.select().from(reviews).where(eq(reviews.proposalId, proposal!.id))).toHaveLength(1);
  });

  // The review can outrun the pull request that carries it. GitHub redelivers,
  // and #224's ingest is what creates the row this hangs off.
  it("skips a review for a pull request that has not been ingested yet", async () => {
    const name = "review-orphan-repo";
    const created = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(created.status).toBe(201);
    const mirrored = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${name}/mirror`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        remote_url: "https://github.com/upstream-org/upstream-repo.git",
        direction: "inbound",
        credential: "upstream-pat",
      }),
    });
    const { webhook_secret } = (await mirrored.json()) as { webhook_secret: string };

    const res = await deliver(
      name,
      webhook_secret,
      "pull_request_review",
      reviewPayload({ id: 9501, state: "approved", login: login("early"), userId: uid() }),
    );
    expect(await res.json()).toMatchObject({ skipped: "no shadow proposal for #482" });
  });

  it("records no approval at all rather than one that can never count", async () => {
    const name = "review-nouser-repo";
    const { repo, webhook_secret } = await seed(name, login("author5"), uid());

    const res = await deliver(name, webhook_secret, "pull_request_review", {
      action: "submitted",
      review: { id: 9601, state: "approved", body: "", user: null },
      pull_request: { number: 482 },
    });
    expect(await res.json()).toMatchObject({ skipped: "review names no upstream user" });

    const [proposal] = await db.select().from(proposals).where(eq(proposals.repoId, repo.id));
    expect(await db.select().from(reviews).where(eq(reviews.proposalId, proposal!.id))).toHaveLength(0);
  });
});
