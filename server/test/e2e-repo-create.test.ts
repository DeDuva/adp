import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, count, eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { identities, orgs, repos } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";

// #89 (docs/m4-postmortem-audit.md §P0-5/§P0-6): the two negative cases the
// audit named as this fix's proof — concurrent creates of one owner/name
// yield exactly one row (the repos_owner_name_idx unique index is the
// authority, not the pre-insert existence check), and a traversal owner is
// rejected with a 4xx before it reaches path.join or names an orgs row.
describe.skipIf(skipWithoutDb)("#89: repo create — uniqueness under race, owner validation", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let writeToken: string;

  async function api(pathAndQuery: string, init: RequestInit = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
      ...init,
      headers: { Authorization: `Bearer ${writeToken}`, "Content-Type": "application/json", ...init.headers },
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-repo-create-git-"));
    const gitBackend = new GitBackend(gitRoot);

    app = Fastify({ logger: false });
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerGitHttpRoutes(app, gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [writer] = await db.insert(identities).values({ kind: "human", principal: `rc-writer-${Date.now()}` }).returning();
    writeToken = await mintToken(db, writer!.id, ["repo:write"]);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("concurrent creates of one owner/name yield exactly one row, one org, one 201", async () => {
    // A fresh owner on purpose: the same burst also races findOrCreateOrg's
    // select-then-insert, which used to hand the loser an unhandled 23505.
    const owner = `rc-race-${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: "target" }) }),
      ),
    );

    const created = results.filter((r) => r.status === 201);
    const conflicted = results.filter((r) => r.status === 422);
    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(7);

    const [repoCount] = await db
      .select({ n: count() })
      .from(repos)
      .where(and(eq(repos.owner, owner), eq(repos.name, "target")));
    expect(repoCount!.n).toBe(1);

    const [orgCount] = await db.select({ n: count() }).from(orgs).where(eq(orgs.name, owner));
    expect(orgCount!.n).toBe(1);
  });

  it("rejects a traversal owner with 422 — no repo row, no orgs row, nothing outside gitRoot", async () => {
    // One path segment to the router (the slashes are %2F), which
    // find-my-way decodes to "../../<sibling>/escape" before the handler
    // sees it — the exact shape audit §P0-5 demonstrates.
    const sibling = `rc-escape-${Date.now()}`;
    const traversal = `..%2F..%2F${sibling}%2Fescape`;
    const decoded = `../../${sibling}/escape`;

    const res = await api(`/api/v3/repos/${traversal}`, { method: "POST", body: JSON.stringify({ name: "x" }) });
    expect(res.status).toBe(422);

    const [orgCount] = await db.select({ n: count() }).from(orgs).where(eq(orgs.name, decoded));
    expect(orgCount!.n).toBe(0);
    const [repoCount] = await db.select({ n: count() }).from(repos).where(eq(repos.owner, decoded));
    expect(repoCount!.n).toBe(0);
    // gitRoot is a mkdtemp directory, so a successful escape would have
    // created <tmpdir>/../<sibling> relative to it — i.e. this exact path.
    await expect(stat(path.join(gitRoot, "..", "..", sibling))).rejects.toThrow();
  });

  it("rejects a bare '..' owner (it matches the name charset, so the charset alone is not the guard)", async () => {
    // node:http, not fetch or app.inject: both of those parse the URL the
    // WHATWG way, which percent-decodes %2E and then resolves the resulting
    // ".." as a dot-segment, so the request would arrive at /api/v3 and
    // never test the route. A raw client is under no such obligation —
    // http.request sends the path verbatim, and find-my-way decodes %2E%2E
    // to ".." server-side.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/v3/repos/%2E%2E",
          headers: { Authorization: `Bearer ${writeToken}`, "Content-Type": "application/json" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ name: "x" }));
    });
    expect(status).toBe(422);
  });

  it("rejects a traversal org on the GitHub-standard org create path", async () => {
    const res = await api(`/api/v3/orgs/..%2F..%2Ftmp%2Fx/repos`, { method: "POST", body: JSON.stringify({ name: "x" }) });
    expect(res.status).toBe(422);
  });

  it("git http: a traversal owner reads as 404, not a filesystem probe", async () => {
    // The proxy resolves repos off the filesystem (exists() -> repoPath),
    // so this exercises repoPath's own guard: the throw is caught by
    // exists(), and the prober learns "not found" — same answer as any
    // other absent repo.
    const res = await fetch(`http://127.0.0.1:${port}/..%2F..%2Ftmp/x.git/info/refs?service=git-upload-pack`, {
      headers: { Authorization: `Bearer ${writeToken}` },
    });
    expect(res.status).toBe(404);
  });
});
