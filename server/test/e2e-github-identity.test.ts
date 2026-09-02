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
import { externalIdentities, identities, intents, issues, proposals } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerMirrorRoutes } from "../src/http-rest/mirrors.js";
import { registerMirrorWebhookRoutes, registerMirrorWebhookRawBodyParser } from "../src/http-rest/mirror-webhook.js";
import { resolveGitHubIdentity, githubIssuer } from "../src/core/github-identity.js";

const CREDENTIAL_KEY = "e2e-gh-identity-credential-key";

// #230 — a change that arrived through GitHub is attributed to its author.
//
// Mirror inbound attributed everything to `mirror:github:<owner>/<name>`: a
// statement about how the record arrived, written into the field that says who
// made the change. It is also what makes 5-4 impossible — `one_approval` is
// author-independent (#121), so a proposal authored by the same system identity
// that ingests its approvals is one nothing can ever approve.
//
// The half of this worth testing hardest is not the attribution, it is the
// keying. GitHub names a commit's author by login and nothing else, and names a
// pull request's author by login *and* numeric id. Keying on whichever is
// present would give one person two identities the first time they both push
// and open a pull request.
describe.skipIf(skipWithoutDb)("#230: GitHub authorship", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  const owner = `gh-identity-owner-${Date.now()}`;
  // Logins and ids are unique per run for the same reason `owner` is: the test
  // database outlives a single `vitest` invocation, and these cases assert on
  // the *absence* of a row — which a previous run's leftovers quietly satisfy.
  const run = Date.now();
  const login = (name: string) => `${name}-${run}`;
  let nextId = run % 1_000_000;
  const uid = () => ++nextId;

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-gh-identity-"));
    const gitBackend = new GitBackend(gitRoot);

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
      .values({ kind: "human", principal: `gh-identity-e2e-${Date.now()}` })
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

  async function principalOf(identityId: string) {
    const [row] = await db.select().from(identities).where(eq(identities.id, identityId));
    return row!.principal;
  }

  it("attributes an ingested pull request to the person who opened it", async () => {
    const name = "attribution-pr-repo";
    const aliceId = uid();
    const repo = await createRepo(name);
    const { webhook_secret } = await createMirror(name);

    await deliver(name, webhook_secret, "pull_request", {
      action: "opened",
      pull_request: {
        number: 482,
        title: "Gate the job lease",
        state: "open",
        html_url: "https://github.com/upstream-org/upstream-repo/pull/482",
        head: { ref: "fix/92", sha: "a".repeat(40) },
        base: { ref: "main" },
        user: { id: aliceId, login: login("alice"), type: "User" },
      },
    });

    const [proposal] = await db.select().from(proposals).where(eq(proposals.repoId, repo.id));
    expect(await principalOf(proposal!.authorId)).toBe(`github:${login("alice")}`);

    // The key is the numeric id, because a login is renameable and an id is
    // not.
    const [link] = await db
      .select()
      .from(externalIdentities)
      .where(
        and(eq(externalIdentities.issuer, githubIssuer("github.com")), eq(externalIdentities.subject, String(aliceId))),
      );
    expect(link!.identityId).toBe(proposal!.authorId);
  });

  it("attributes an ingested issue, and its intent, to the person who filed it", async () => {
    const name = "attribution-issue-repo";
    const bobId = uid();
    const repo = await createRepo(name);
    const { webhook_secret } = await createMirror(name);

    await deliver(name, webhook_secret, "issues", {
      action: "opened",
      issue: {
        number: 92,
        title: "Gate job lease is not enforced",
        state: "open",
        html_url: "https://github.com/upstream-org/upstream-repo/issues/92",
        user: { id: bobId, login: login("bob"), type: "User" },
      },
      repository: { html_url: "https://github.com/upstream-org/upstream-repo" },
    });

    const [issue] = await db.select().from(issues).where(eq(issues.repoId, repo.id));
    expect(await principalOf(issue!.authorId)).toBe(`github:${login("bob")}`);
    expect(await db.select().from(intents).where(eq(intents.repoId, repo.id))).toHaveLength(1);
  });

  // A bot is not a human, and the identity kind is what the trust plane reads
  // when it asks whether a judgment came from a person.
  it("records a GitHub App as an agent identity rather than a human one", async () => {
    const botLogin = login("dependabot[bot]");
    const resolved = await resolveGitHubIdentity(db, "github.com", {
      id: uid(),
      login: botLogin,
      type: "Bot",
    });
    expect(resolved!.kind).toBe("agent");
    expect(resolved!.principal).toBe(`github:${botLogin}`);
  });

  // The keying case. A push names an author by login only; a pull request names
  // the same person by login and id. Both must land on one identity.
  it("upgrades a login-keyed identity in place when the same person is later seen with an id", async () => {
    const carol = login("carol");
    const carolId = uid();
    const fromPush = await resolveGitHubIdentity(db, "github.com", { login: carol });
    expect(fromPush!.principal).toBe(`github:${carol}`);

    const [before] = await db
      .select()
      .from(externalIdentities)
      .where(
        and(eq(externalIdentities.issuer, githubIssuer("github.com")), eq(externalIdentities.subject, `login:${carol}`)),
      );
    expect(before).toBeDefined();

    const fromPullRequest = await resolveGitHubIdentity(db, "github.com", { id: carolId, login: carol });
    expect(fromPullRequest!.identityId).toBe(fromPush!.identityId);

    // Rewritten, not duplicated.
    const [after] = await db
      .select()
      .from(externalIdentities)
      .where(eq(externalIdentities.id, before!.id));
    expect(after!.subject).toBe(String(carolId));
    const stale = await db
      .select()
      .from(externalIdentities)
      .where(
        and(eq(externalIdentities.issuer, githubIssuer("github.com")), eq(externalIdentities.subject, `login:${carol}`)),
      );
    expect(stale).toHaveLength(0);
  });

  // And the mirror image: known by id first, then seen by login on a push.
  it("finds an id-keyed identity from a login-only sighting", async () => {
    const dave = login("dave");
    const fromPullRequest = await resolveGitHubIdentity(db, "github.com", { id: uid(), login: dave });
    const fromPush = await resolveGitHubIdentity(db, "github.com", { login: dave });
    expect(fromPush!.identityId).toBe(fromPullRequest!.identityId);
    expect(
      await db
        .select()
        .from(externalIdentities)
        .where(
          and(eq(externalIdentities.issuer, githubIssuer("github.com")), eq(externalIdentities.subject, `login:${dave}`)),
        ),
    ).toHaveLength(0);
  });

  // Two hosts, one login, two people. This is why external_identities is
  // (issuer, subject)-keyed rather than subject-keyed.
  it("keeps the same login on two hosts as two identities", async () => {
    const erin = login("erin");
    const erinId = uid();
    const onGitHub = await resolveGitHubIdentity(db, "github.com", { id: erinId, login: erin });
    const onEnterprise = await resolveGitHubIdentity(db, "git.example.com", { id: erinId, login: erin });
    expect(onEnterprise!.identityId).not.toBe(onGitHub!.identityId);
  });

  // GitHub omits the user on a few deliveries and on a deleted account.
  // Inventing a person there would be worse than saying the mirror ingested it.
  it("resolves nobody when the payload names nobody", async () => {
    expect(await resolveGitHubIdentity(db, "github.com", null)).toBeNull();
    expect(await resolveGitHubIdentity(db, "github.com", { id: null, login: null })).toBeNull();
  });
});
