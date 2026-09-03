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
import { gateResults, identities, intents, issues, mirrors, proposals, reviews } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerMirrorRoutes } from "../src/http-rest/mirrors.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { repoAccessCheck, findRepo } from "../src/core/repos-lookup.js";
import { pollMirror } from "../src/core/mirror-inbound-poller.js";

const execFileAsync = promisify(execFile);
const CREDENTIAL_KEY = "e2e-inbound-poller-credential-key";
const SIGNING_KEY = "e2e-inbound-poller-signing-key";

// #228 — companion mode on a machine nothing can reach.
//
// `adp init` configures the mirror and then prints a webhook URL and a secret
// for a human to paste into GitHub's settings. Until that is done by hand,
// inbound ingests nothing; a developer with no public hostname cannot do it at
// all. That is most people evaluating this, so polling is not a degraded
// substitute for the webhook — it is the version of the mode that runs on the
// machine they have.
//
// The design constraint is therefore that it produces the *same* record rather
// than a similar one, and the way that is achieved is that every fact goes
// through the function the webhook calls. Branch syncing in particular is
// `syncBranchFromUpstream`, which `e2e-mirror.test.ts` already drives from the
// other side — so what is asserted here is the polling: the cursor, the
// filtering, the idempotency, and the failure isolation.
describe.skipIf(skipWithoutDb)("#228: inbound poller", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitBackend: GitBackend;
  let signer: Signer;
  let gitRoot: string;
  let port: number;
  let token: string;
  const owner = `poller-owner-${Date.now()}`;
  const run = Date.now();
  const login = (n: string) => `${n}-${run}`;
  let nextId = run % 1_000_000;
  const uid = () => ++nextId;

  // What the fake api.github.com answers, per path prefix. Assigned per test.
  let upstream: Record<string, unknown> = {};
  let calls: string[] = [];
  let failing: string | null = null;

  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    const key = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "");
    calls.push(`${key}${url.search}`);
    if (failing && key.startsWith(failing)) {
      return new Response("{}", { status: 502 });
    }
    const match = Object.keys(upstream).find((k) => key.startsWith(k));
    const body = match ? upstream[match] : [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-poller-"));
    gitBackend = new GitBackend(gitRoot);
    signer = new Signer(SIGNING_KEY);

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerMirrorRoutes(app, db, CREDENTIAL_KEY);
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `poller-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  // A repository whose `main` really exists here, so the branch loop has a
  // local sha to compare against. The remote URL has to be a real GitHub one
  // for the API path to be derived from it.
  async function seed(name: string) {
    const created = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(created.status).toBe(201);

    const dir = await mkdtemp(path.join(tmpdir(), "adp-e2e-poller-clone-"));
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
    const sha = (await git("rev-parse", "HEAD")).stdout.trim();
    await rm(dir, { recursive: true, force: true });

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

    const repo = (await findRepo(db, owner, name))!;
    const [mirror] = await db.select().from(mirrors).where(eq(mirrors.repoId, repo.id));
    return { repo, mirror: mirror!, sha };
  }

  function poll(mirror: typeof mirrors.$inferSelect, repo: { id: string; owner: string; name: string }) {
    return pollMirror(
      { db, gitBackend, signer, credentialKey: CREDENTIAL_KEY, publicUrl: "https://adp.example.com", fetchImpl },
      mirror,
      repo,
    );
  }

  async function reload(mirrorId: string) {
    const [row] = await db.select().from(mirrors).where(eq(mirrors.id, mirrorId));
    return row!;
  }

  // The item, in one pass: a pull request, its approval, an issue and a CI
  // result all reach ADP with no webhook configured and nothing reaching in.
  it("ingests pull requests, reviews, issues and runs with no webhook and no public URL", async () => {
    const name = "poll-everything";
    const { repo, mirror, sha } = await seed(name);
    calls = [];
    upstream = {
      "/branches": [{ name: "main", commit: { sha } }],
      "/pulls/482/reviews": [
        {
          id: 77001,
          state: "APPROVED",
          body: "",
          submitted_at: "2026-09-02T10:00:00Z",
          user: { id: uid(), login: login("reviewer"), type: "User" },
        },
      ],
      "/pulls": [
        {
          number: 482,
          title: "Gate the job lease",
          body: "Closes #92.",
          state: "open",
          updated_at: new Date().toISOString(),
          html_url: "https://github.com/upstream-org/upstream-repo/pull/482",
          head: { ref: "fix/92", sha: "a".repeat(40) },
          base: { ref: "main" },
          user: { id: uid(), login: login("opener"), type: "User" },
        },
      ],
      "/issues": [
        {
          number: 92,
          title: "Gate job lease is not enforced",
          body: "",
          state: "open",
          html_url: "https://github.com/upstream-org/upstream-repo/issues/92",
          user: { id: uid(), login: login("filer"), type: "User" },
        },
      ],
      "/actions/runs": {
        workflow_runs: [
          {
            id: 55001,
            name: "CI",
            head_sha: "a".repeat(40),
            status: "completed",
            conclusion: "success",
            run_number: 7,
            event: "push",
            updated_at: new Date().toISOString(),
          },
        ],
      },
    };

    const summary = await poll(mirror, repo);
    expect(summary.errors).toEqual([]);
    expect(summary).toMatchObject({ pullRequests: 1, reviews: 1, issues: 1, runs: 1 });

    // The branch was already where upstream says it is, so nothing was fetched
    // — the poller compares before it reaches for the network.
    expect(summary.branches).toBe(0);

    expect(await db.select().from(proposals).where(eq(proposals.repoId, repo.id))).toHaveLength(1);
    expect(await db.select().from(intents).where(eq(intents.repoId, repo.id))).toHaveLength(1);
    expect(await db.select().from(issues).where(eq(issues.repoId, repo.id))).toHaveLength(1);
    expect(
      await db.select().from(gateResults).where(and(eq(gateResults.repoId, repo.id), eq(gateResults.name, "actions/CI"))),
    ).toHaveLength(1);

    const [proposal] = await db.select().from(proposals).where(eq(proposals.repoId, repo.id));
    expect(await db.select().from(reviews).where(eq(reviews.proposalId, proposal!.id))).toHaveLength(1);

    // Ingested through the same functions the webhook calls, so the shadow
    // proposal carries the same upstream identity.
    expect(proposal!.upstreamNumber).toBe(482);
    expect(proposal!.number).toBe(482);
  });

  // Running the poller beside a configured webhook has to be safe rather than
  // merely unlikely to collide, because an instance that has both is the normal
  // case once someone deploys what they evaluated.
  it("records nothing new on a second pass over the same upstream state", async () => {
    const name = "poll-idempotent";
    const { repo, mirror, sha } = await seed(name);
    upstream = {
      "/branches": [{ name: "main", commit: { sha } }],
      "/pulls": [
        {
          number: 500,
          title: "Second pass",
          state: "open",
          updated_at: new Date().toISOString(),
          html_url: "https://github.com/upstream-org/upstream-repo/pull/500",
          head: { ref: "f", sha: "b".repeat(40) },
          base: { ref: "main" },
          user: { id: uid(), login: login("twice"), type: "User" },
        },
      ],
    };

    const first = await poll(mirror, repo);
    expect(first.pullRequests).toBe(1);

    // Deliberately *not* advancing `updated_at`, so the second pass sees the
    // same row again rather than filtering it out — the guarantee under test is
    // that re-ingesting an unchanged fact writes nothing, not that the cursor
    // hides it.
    const second = await poll(await reload(mirror.id), repo);
    expect(second.pullRequests).toBe(0);
    expect(await db.select().from(proposals).where(eq(proposals.repoId, repo.id))).toHaveLength(1);
  });

  it("advances its cursor to when the poll started, and asks upstream only for what is newer", async () => {
    const name = "poll-cursor";
    const { repo, mirror, sha } = await seed(name);
    expect(mirror.lastPolledAt).toBeNull();

    upstream = { "/branches": [{ name: "main", commit: { sha } }] };
    calls = [];
    const before = Date.now();
    await poll(mirror, repo);

    const after = await reload(mirror.id);
    expect(after.lastPolledAt).not.toBeNull();
    expect(after.lastPolledAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);

    // The first poll backfills a bounded window of already-finished work; the
    // second asks only for what changed since it ran.
    calls = [];
    await poll(after, repo);
    const issuesCall = calls.find((c) => c.startsWith("/issues"));
    expect(issuesCall).toContain(`since=${encodeURIComponent(after.lastPolledAt!.toISOString())}`);
  });

  // A poll that failed must not move the cursor past a window it never read,
  // or the work in that window is invisible forever.
  it("leaves the cursor where it was when part of the poll failed", async () => {
    const name = "poll-failure";
    const { repo, mirror, sha } = await seed(name);
    upstream = { "/branches": [{ name: "main", commit: { sha } }] };
    failing = "/issues";

    const summary = await poll(mirror, repo);
    failing = null;

    expect(summary.errors.some((e) => e.startsWith("issues:"))).toBe(true);
    expect((await reload(mirror.id)).lastPolledAt).toBeNull();
  });

  // One repository's expired credential must not stop every other repository
  // from syncing — a poller that dies on the first failure is one that silently
  // stops being a poller.
  it("reports a branch that cannot be synced without abandoning the rest of the poll", async () => {
    const name = "poll-partial";
    const { repo, mirror, sha } = await seed(name);
    upstream = {
      // A sha this instance does not have, so the branch loop reaches for the
      // network — which, against a real github.com URL in a test, fails.
      "/branches": [{ name: "main", commit: { sha: "c".repeat(40) } }],
      "/issues": [
        {
          number: 93,
          title: "Still ingested",
          state: "open",
          html_url: "https://github.com/upstream-org/upstream-repo/issues/93",
          user: { id: uid(), login: login("partial"), type: "User" },
        },
      ],
    };
    void sha;

    const summary = await poll(mirror, repo);
    expect(summary.errors.some((e) => e.startsWith("branch main:"))).toBe(true);
    // The issue still landed.
    expect(summary.issues).toBe(1);
    expect(await db.select().from(issues).where(eq(issues.repoId, repo.id))).toHaveLength(1);
  });
});
