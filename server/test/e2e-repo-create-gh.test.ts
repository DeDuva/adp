import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { skipWithoutDb } from "./require-db.js";
import { identities, orgs } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { loadGitHubSchema } from "../src/http-gql/schema.js";
import { attachResolvers } from "../src/http-gql/attach-resolvers.js";
import { createResolvers } from "../src/http-gql/resolvers.js";
import { registerGraphQLRoute } from "../src/http-gql/route.js";
import { findRepo } from "../src/core/repos-lookup.js";
import { fromGlobalId } from "../src/http-gql/global-id.js";

const PUBLIC_URL = "https://adp.example.com";

// #196 — `gh repo create <owner>/<name>`.
//
// It failed on the *first* command of the first-contact journey, with a 404
// that explained nothing: `gh` resolves the owner before creating, to decide
// whether it is a user or an organisation, and that route was not served.
//
// The conformance suite runs the real, unmodified `gh` against both halves, so
// this file covers what a shell script cannot: the exact shapes, and the
// refusal for the bare `gh repo create <name>` form — which cannot be a
// conformance step, because a suite that asserts a failure by failing has
// nowhere to put the difference between the two.
describe.skipIf(skipWithoutDb)("#196: gh repo create", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  const owner = `repo-create-owner-${Date.now()}`;

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-repo-create-"));
    const gitBackend = new GitBackend(gitRoot);

    app = Fastify({ logger: false });
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, PUBLIC_URL);
    const schema = loadGitHubSchema();
    attachResolvers(schema, createResolvers(gitBackend, "k"));
    registerGraphQLRoute(app, schema, db);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `repo-create-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  function gql(query: string, variables?: Record<string, unknown>) {
    return fetch(`http://127.0.0.1:${port}/api/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  }

  // The exact mutation `gh` sends, captured from a real `gh repo create` run
  // against a probe. Written out rather than paraphrased: what makes this test
  // worth anything is that it is the request the incumbent client makes.
  const CREATE = `
    mutation RepositoryCreate($input: CreateRepositoryInput!) {
      createRepository(input: $input) {
        repository { id name owner { login } url }
      }
    }`;

  it("resolves the owner as an organisation, with the node id the mutation takes", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v3/users/${owner}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { login: string; type: string; node_id: string };

    // The honest answer: ADP's owners *are* orgs, and `gh` branches on this to
    // choose the org creation path over the personal one.
    expect(body.type).toBe("Organization");
    expect(body.login).toBe(owner);

    const [org] = await db.select().from(orgs).where(eq(orgs.name, owner));
    expect(fromGlobalId(body.node_id)).toEqual({ typeName: "Organization", internalId: org!.id });

    // Owner-shaped, not person-shaped. This route must not become a way to
    // enumerate principals.
    expect(JSON.stringify(body)).not.toContain("members");
    expect(body).not.toHaveProperty("email");
  });

  it("creates the repository through the mutation gh actually sends", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v3/users/${owner}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { node_id } = (await res.json()) as { node_id: string };

    const created = await gql(CREATE, {
      input: {
        name: "gh-made",
        visibility: "PRIVATE",
        ownerId: node_id,
        hasIssuesEnabled: true,
        hasWikiEnabled: true,
      },
    });
    const body = (await created.json()) as {
      errors?: { message: string }[];
      data: { createRepository: { repository: { name: string; owner: { login: string } } } };
    };
    expect(body.errors).toBeUndefined();
    // `owner` is a field resolver reading `parent.__repo`, so a hand-shaped
    // repository resolves it to undefined — which fails only in `gh`, not in a
    // query that asks for the scalar fields.
    expect(body.data.createRepository.repository).toMatchObject({
      name: "gh-made",
      owner: { login: owner },
    });

    expect(await findRepo(db, owner, "gh-made")).toBeTruthy();
  });

  // The bare `gh repo create <name>` form used to exit 0 and create nothing
  // reachable, because the owner it derives is the token's principal rather
  // than an org. Refusing is the improvement: silence was the bug.
  it("refuses to invent an owner when the mutation names none", async () => {
    const res = await gql(CREATE, { input: { name: "nowhere", visibility: "PRIVATE" } });
    const body = (await res.json()) as { errors?: { message: string }[] };
    expect(body.errors?.[0]?.message).toContain("no personal repository namespace");
    expect(body.errors?.[0]?.message).toContain("gh repo create <owner>/<name>");
    expect(await findRepo(db, owner, "nowhere")).toBeFalsy();
  });

  it("says where owners come from rather than only that this one is missing", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v3/users/nobody-provisioned-this`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    expect((await res.json()) as { adp_equivalent: string }).toMatchObject({
      adp_equivalent: expect.stringContaining("POST /api/adp/orgs"),
    });
  });

  it("refuses a mutation whose ownerId is not an organisation", async () => {
    const res = await gql(CREATE, {
      input: { name: "wrong-type", visibility: "PRIVATE", ownerId: Buffer.from("User:1").toString("base64") },
    });
    expect(((await res.json()) as { errors?: { message: string }[] }).errors?.[0]?.message).toContain(
      "is not an organization id",
    );
  });
});
