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
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { repoAccessCheck } from "../src/core/repos-lookup.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerIssueRoutes } from "../src/http-rest/issues.js";
import { registerProposalRoutes } from "../src/http-rest/proposals.js";
import { loadGitHubSchema } from "../src/http-gql/schema.js";
import { attachResolvers } from "../src/http-gql/attach-resolvers.js";
import { createResolvers } from "../src/http-gql/resolvers.js";
import { registerGraphQLRoute } from "../src/http-gql/route.js";
import { toGlobalId } from "../src/http-gql/global-id.js";

const execFileAsync = promisify(execFile);

interface GraphQLResponse<T = unknown> {
  data: T | null;
  errors?: { message: string }[];
}

// M1b read slice: GitHub's real, unmodified public schema (spec/graphql/
// github.graphql) loaded into graphql-js with resolvers for the fields
// gh repo view / issue list+view / pr list+view need. DB-gated like the
// REST e2e suite. Not covered here: mutations (pr create/merge/review,
// issue create/close via GraphQL — those exist over REST already), and
// running the actual `gh` binary against this — that's the record-replay
// conformance suite, a separate follow-up
describe.skipIf(skipWithoutDb)("M1b GraphQL: read path", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  let repoId: string;
  // Unique per run — see the matching comment in test/e2e.test.ts.
  const owner = `gql-owner-${Date.now()}`;

  async function gql<T = unknown>(query: string, variables?: Record<string, unknown>, auth = true) {
    const res = await fetch(`http://127.0.0.1:${port}/api/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ query, variables }),
    });
    return { status: res.status, body: (await res.json()) as GraphQLResponse<T> };
  }

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-gql-git-"));
    const gitBackend = new GitBackend(gitRoot);

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerIssueRoutes(app, db);
    registerProposalRoutes(app, db, gitBackend, "e2e-test-credential-key");

    const schema = loadGitHubSchema();
    attachResolvers(schema, createResolvers(gitBackend, "e2e-test-credential-key"));
    registerGraphQLRoute(app, schema, db);

    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `gql-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);

    const createRepoRes = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "widget" }),
    });
    const createdRepo = (await createRepoRes.json()) as { id: string };
    repoId = createdRepo.id;

    // Give the repo a real commit so defaultBranchRef.target.oid resolves.
    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-gql-clone-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/widget.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo hi > README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    await rm(cloneDir, { recursive: true, force: true });

    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/widget/issues`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "First issue" }),
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("resolves RepositoryInfo, matching what `gh repo view` requests", async () => {
    const { status, body } = await gql<{
      repository: { name: string; nameWithOwner: string; owner: { login: string }; defaultBranchRef: { name: string; target: { oid: string } } };
    }>(
      `query {
        repository(owner: "${owner}", name: "widget") {
          name
          nameWithOwner
          owner { login }
          defaultBranchRef { name target { oid } }
        }
      }`,
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data!.repository.nameWithOwner).toBe(`${owner}/widget`);
    expect(body.data!.repository.owner.login).toBe(owner);
    expect(body.data!.repository.defaultBranchRef.name).toBe("main");
    expect(body.data!.repository.defaultBranchRef.target.oid).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns null for a repository that doesn't exist, not an error", async () => {
    const { body } = await gql<{ repository: null }>(
      `query { repository(owner: "nope", name: "nope") { name } }`,
    );
    expect(body.errors).toBeUndefined();
    expect(body.data!.repository).toBeNull();
  });

  it("lists and fetches issues, matching `gh issue list`/`gh issue view`", async () => {
    const listRes = await gql<{ repository: { issues: { totalCount: number; nodes: { number: number; title: string }[] } } }>(
      `query { repository(owner: "${owner}", name: "widget") { issues(first: 10) { totalCount nodes { number title } } } }`,
    );
    expect(listRes.body.errors).toBeUndefined();
    expect(listRes.body.data!.repository.issues.totalCount).toBe(1);
    const number = listRes.body.data!.repository.issues.nodes[0]!.number;

    const viewRes = await gql<{ repository: { issue: { title: string; state: string; author: { login: string } | null } } }>(
      `query($n: Int!) { repository(owner: "${owner}", name: "widget") { issue(number: $n) { title state author { login } } } }`,
      { n: number },
    );
    expect(viewRes.body.errors).toBeUndefined();
    expect(viewRes.body.data!.repository.issue.title).toBe("First issue");
    expect(viewRes.body.data!.repository.issue.state).toBe("OPEN");
    expect(viewRes.body.data!.repository.issue.author?.login).toContain("gql-e2e-");
  });

  it("lists and fetches pull requests, matching `gh pr list`/`gh pr view`", async () => {
    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-gql-pr-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/widget.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo more >> README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-am", "feature commit"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "feature"], { cwd: cloneDir });
    await rm(cloneDir, { recursive: true, force: true });

    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/widget/pulls`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Add more", head: "feature", base: "main" }),
    });

    const listRes = await gql<{ repository: { pullRequests: { totalCount: number; nodes: { number: number }[] } } }>(
      `query { repository(owner: "${owner}", name: "widget") { pullRequests(first: 10) { totalCount nodes { number } } } }`,
    );
    expect(listRes.body.errors).toBeUndefined();
    expect(listRes.body.data!.repository.pullRequests.totalCount).toBe(1);
    const number = listRes.body.data!.repository.pullRequests.nodes[0]!.number;

    const viewRes = await gql<{
      repository: { pullRequest: { title: string; state: string; baseRefName: string; headRefName: string } };
    }>(
      `query($n: Int!) { repository(owner: "${owner}", name: "widget") { pullRequest(number: $n) { title state baseRefName headRefName } } }`,
      { n: number },
    );
    expect(viewRes.body.errors).toBeUndefined();
    expect(viewRes.body.data!.repository.pullRequest.state).toBe("OPEN");
    expect(viewRes.body.data!.repository.pullRequest.baseRefName).toBe("main");
    expect(viewRes.body.data!.repository.pullRequest.headRefName).toBe("feature");
  });

  it("resolves a Repository through node(id), decoding the global ID", async () => {
    const globalId = toGlobalId("Repository", repoId);
    const { body } = await gql<{ node: { name: string } }>(
      `query($id: ID!) { node(id: $id) { ... on Repository { name } } }`,
      { id: globalId },
    );
    expect(body.errors).toBeUndefined();
    expect(body.data!.node.name).toBe("widget");
  });

  it("resolves viewer for an authenticated request and errors without one", async () => {
    const authed = await gql<{ viewer: { login: string } }>(`query { viewer { login } }`);
    expect(authed.body.errors).toBeUndefined();
    expect(authed.body.data!.viewer.login).toContain("gql-e2e-");

    const unauthed = await gql(`query { viewer { login } }`, undefined, false);
    expect(unauthed.body.errors).toBeDefined();
    expect(unauthed.body.errors![0]!.message).toMatch(/authentication/i);
  });

  it("fails as a resolver error, not a validation error, on a field we haven't backed", async () => {
    // stargazerCount is Int! in the real schema — real, valid query; we just
    // don't populate it. This is the entire point of loading GitHub's SDL
    // unmodified: the failure must be a
    // resolver/execution error, never "Cannot query field ... on type ...".
    const { status, body } = await gql(
      `query { repository(owner: "${owner}", name: "widget") { name stargazerCount } }`,
    );
    expect(status).toBe(200);
    expect(body.errors).toBeDefined();
    expect(body.errors![0]!.message).not.toMatch(/cannot query field/i);
  });

  it("rejects a syntactically invalid query as a GraphQL error, not a crash", async () => {
    const { status, body } = await gql(`query { repository(owner: "x" `);
    expect(status).toBe(200);
    expect(body.errors).toBeDefined();
  });
});

// M1b′ mutation slice: the same
// mutations `gh issue create/close/comment` and `gh pr create/merge/close/
// reopen/ready/review` send. Own repo/fixtures so it doesn't interleave with
// the read-path suite's assertions above.
describe.skipIf(skipWithoutDb)("M1b′ GraphQL: mutations", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  let agentToken: string;
  const owner = `gql-mut-owner-${Date.now()}`;

  async function gql<T = unknown>(query: string, variables?: Record<string, unknown>, authToken = token) {
    const res = await fetch(`http://127.0.0.1:${port}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ query, variables }),
    });
    return { status: res.status, body: (await res.json()) as GraphQLResponse<T> };
  }

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-gql-mut-git-"));
    const gitBackend = new GitBackend(gitRoot);

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    const schema = loadGitHubSchema();
    attachResolvers(schema, createResolvers(gitBackend, "e2e-test-credential-key"));
    registerGraphQLRoute(app, schema, db);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `gql-mut-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);

    const [agentIdentity] = await db
      .insert(identities)
      .values({ kind: "agent", principal: `gql-mut-agent-${Date.now()}` })
      .returning();
    agentToken = await mintToken(db, agentIdentity!.id, ["repo:read", "repo:write"]);
    await grantOwner(db, agentIdentity!.id, owner);

    const createRepoRes = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "widget" }),
    });
    const createdRepo = (await createRepoRes.json()) as { id: string };

    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-gql-mut-clone-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/widget.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo hi > README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo more >> README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-am", "feature commit"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "feature"], { cwd: cloneDir });
    await execFileAsync("git", ["checkout", "-b", "feature2", "main"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo more2 >> README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-am", "feature2 commit"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "feature2"], { cwd: cloneDir });
    await rm(cloneDir, { recursive: true, force: true });

    void createdRepo;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  async function repositoryId(): Promise<string> {
    const { body } = await gql<{ repository: { id: string } }>(
      `query { repository(owner: "${owner}", name: "widget") { id } }`,
    );
    return body.data!.repository.id;
  }

  it("createIssue creates an issue whose author resolves as a Bot for an agent identity", async () => {
    const repoId = await repositoryId();
    const { body } = await gql<{
      createIssue: { issue: { number: number; title: string; state: string; author: { __typename: string; login: string } } };
    }>(
      `mutation($input: CreateIssueInput!) {
        createIssue(input: $input) { issue { number title state author { __typename login } } }
      }`,
      { input: { repositoryId: repoId, title: "Agent-filed issue", body: "from an agent" } },
      agentToken,
    );
    expect(body.errors).toBeUndefined();
    expect(body.data!.createIssue.issue.title).toBe("Agent-filed issue");
    expect(body.data!.createIssue.issue.state).toBe("OPEN");
    expect(body.data!.createIssue.issue.author.__typename).toBe("Bot");
  });

  it("closeIssue closes an issue created via createIssue, and addComment comments on it", async () => {
    const repoId = await repositoryId();
    const created = await gql<{ createIssue: { issue: { id: string; number: number } } }>(
      `mutation($input: CreateIssueInput!) { createIssue(input: $input) { issue { id number } } }`,
      { input: { repositoryId: repoId, title: "To be closed" } },
    );
    const issueId = created.body.data!.createIssue.issue.id;

    const commented = await gql<{ addComment: { subject: { __typename: string } } }>(
      `mutation($input: AddCommentInput!) { addComment(input: $input) { subject { __typename ... on Issue { number } } } }`,
      { input: { subjectId: issueId, body: "a comment" } },
    );
    expect(commented.body.errors).toBeUndefined();
    expect(commented.body.data!.addComment.subject.__typename).toBe("Issue");

    const closed = await gql<{ closeIssue: { issue: { state: string } } }>(
      `mutation($input: CloseIssueInput!) { closeIssue(input: $input) { issue { state } } }`,
      { input: { issueId } },
    );
    expect(closed.body.errors).toBeUndefined();
    expect(closed.body.data!.closeIssue.issue.state).toBe("CLOSED");
  });

  it("createPullRequest, addPullRequestReview, markPullRequestReadyForReview, then mergePullRequest lands it", async () => {
    const repoId = await repositoryId();
    const created = await gql<{ createPullRequest: { pullRequest: { id: string; number: number; state: string } } }>(
      `mutation($input: CreatePullRequestInput!) {
        createPullRequest(input: $input) { pullRequest { id number state } }
      }`,
      { input: { repositoryId: repoId, title: "Add more", baseRefName: "main", headRefName: "feature" } },
    );
    expect(created.body.errors).toBeUndefined();
    const prId = created.body.data!.createPullRequest.pullRequest.id;
    expect(created.body.data!.createPullRequest.pullRequest.state).toBe("OPEN");

    const reviewed = await gql<{
      addPullRequestReview: { pullRequestReview: { state: string; author: { login: string } | null } };
    }>(
      `mutation($input: AddPullRequestReviewInput!) {
        addPullRequestReview(input: $input) { pullRequestReview { state author { login } } }
      }`,
      { input: { pullRequestId: prId, event: "APPROVE", body: "lgtm" } },
    );
    expect(reviewed.body.errors).toBeUndefined();
    expect(reviewed.body.data!.addPullRequestReview.pullRequestReview.state).toBe("APPROVED");

    const readied = await gql<{ markPullRequestReadyForReview: { pullRequest: { number: number } } }>(
      `mutation($input: MarkPullRequestReadyForReviewInput!) {
        markPullRequestReadyForReview(input: $input) { pullRequest { number } }
      }`,
      { input: { pullRequestId: prId } },
    );
    expect(readied.body.errors).toBeUndefined();

    const merged = await gql<{ mergePullRequest: { pullRequest: { state: string }; actor: { login: string } | null } }>(
      `mutation($input: MergePullRequestInput!) {
        mergePullRequest(input: $input) { pullRequest { state } actor { login } }
      }`,
      { input: { pullRequestId: prId } },
    );
    expect(merged.body.errors).toBeUndefined();
    expect(merged.body.data!.mergePullRequest.pullRequest.state).toBe("MERGED");
  });

  it("closePullRequest then reopenPullRequest round-trips state on a second PR", async () => {
    const repoId = await repositoryId();
    const created = await gql<{ createPullRequest: { pullRequest: { id: string } } }>(
      `mutation($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { id } } }`,
      { input: { repositoryId: repoId, title: "Add more2", baseRefName: "main", headRefName: "feature2" } },
    );
    const prId = created.body.data!.createPullRequest.pullRequest.id;

    const closed = await gql<{ closePullRequest: { pullRequest: { state: string } } }>(
      `mutation($input: ClosePullRequestInput!) { closePullRequest(input: $input) { pullRequest { state } } }`,
      { input: { pullRequestId: prId } },
    );
    expect(closed.body.errors).toBeUndefined();
    expect(closed.body.data!.closePullRequest.pullRequest.state).toBe("CLOSED");

    const reopened = await gql<{ reopenPullRequest: { pullRequest: { state: string } } }>(
      `mutation($input: ReopenPullRequestInput!) { reopenPullRequest(input: $input) { pullRequest { state } } }`,
      { input: { pullRequestId: prId } },
    );
    expect(reopened.body.errors).toBeUndefined();
    expect(reopened.body.data!.reopenPullRequest.pullRequest.state).toBe("OPEN");
  });

  it("addComment rejects a PullRequest subject, the one known gap in this slice", async () => {
    const repoId = await repositoryId();
    const created = await gql<{ createPullRequest: { pullRequest: { id: string } } }>(
      `mutation($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { id } } }`,
      { input: { repositoryId: repoId, title: "Yet another", baseRefName: "main", headRefName: "feature" } },
    );
    const prId = created.body.data!.createPullRequest.pullRequest.id;

    const { body } = await gql(
      `mutation($input: AddCommentInput!) { addComment(input: $input) { clientMutationId } }`,
      { input: { subjectId: prId, body: "comment on a PR" } },
    );
    expect(body.errors).toBeDefined();
  });
});
