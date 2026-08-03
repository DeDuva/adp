import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { identities, operations } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { findRepo } from "../src/core/repos-lookup.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerProposalRoutes } from "../src/http-rest/proposals.js";
import { registerGateRoutes } from "../src/http-rest/gates.js";

const execFileAsync = promisify(execFile);

// M3 / A8 (docs/pragmatic_mvp.md M3, docs/m3-readiness-review.md M3-4):
// statistical land criteria. Two behaviours, and the second one is the one that
// must not go wrong quietly:
//
//   gates_confident — green is not enough; the Wilson lower bound on the gate's
//                     trailing pass rate has to clear min_pass_rate.
//   quarantine      — a gate that disagrees with itself on the same commit
//                     stops blocking land, but *visibly*: reported as an
//                     advisory and recorded as a gate.quarantine operation.
describe.skipIf(skipWithoutDb)("M3: statistical land criteria (A8)", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let gitBackend: GitBackend;
  let port: number;
  let token: string;
  const owner = `stats-owner-${Date.now()}`;

  async function api(pathAndQuery: string, init: RequestInit = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body: body as Record<string, unknown> };
  }

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-stats-git-"));
    gitBackend = new GitBackend(gitRoot);

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerProposalRoutes(app, db, gitBackend, "e2e-stats-credential-key", []);
    registerGateRoutes(app, db, new Signer("e2e-stats-signing-key"), "https://adp.example.com", "e2e-stats-credential-key");
    registerGitHttpRoutes(app, gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `stats-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  // A repo whose adp.yaml carries the given `land:` block, plus a feature
  // branch to propose from.
  async function setupRepo(repoName: string, landYaml: string) {
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: repoName }) });

    const dir = await mkdtemp(path.join(tmpdir(), "adp-e2e-stats-clone-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, dir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
    // Read off the *base* ref, so adp.yaml has to be on main. Written
    // directly rather than shelled out: `printf '%s'` leaves \n uninterpreted,
    // which yields invalid YAML and a policy that fails closed — a way for
    // these tests to pass for entirely the wrong reason.
    await writeFile(path.join(dir, "adp.yaml"), landYaml);
    await execFileAsync("git", ["add", "."], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: dir });

    await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: dir });
    await execFileAsync("sh", ["-c", "echo more >> README.md"], { cwd: dir });
    await execFileAsync("git", ["add", "."], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "feature"], { cwd: dir });
    await execFileAsync("git", ["push", "origin", "feature"], { cwd: dir });
    const headSha = (await execFileAsync("git", ["rev-parse", "feature"], { cwd: dir })).stdout.trim();
    await rm(dir, { recursive: true, force: true });

    const pr = await api(`/api/v3/repos/${owner}/${repoName}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: "feature", head: "feature", base: "main" }),
    });
    return { headSha, number: (pr.body as { number: number }).number };
  }

  async function report(repoName: string, sha: string, status: "success" | "failure") {
    const res = await api(`/api/v3/repos/${owner}/${repoName}/gates`, {
      method: "POST",
      body: JSON.stringify({ git_sha: sha, name: "tests", status, summary: status }),
    });
    expect(res.status).toBe(201);
  }

  it("gates_confident blocks a green gate whose trailing pass rate is too weak, and allows it once evidence accumulates", async () => {
    const repoName = "confident";
    const { headSha, number } = await setupRepo(
      repoName,
      "gates:\n  - tests\nland:\n  require:\n    - gates_confident\n  statistical:\n    window: 100\n    min_runs: 4\n    confidence: 0.95\n    min_pass_rate: 0.6\n    quarantine_threshold: 0.9\n",
    );

    // Six results on unrelated commits: four pass, two fail. Distinct shas, so
    // nothing looks flaky — this is a gate that is simply unreliable.
    for (const [i, status] of (["success", "failure", "success", "failure", "success", "success"] as const).entries()) {
      await report(repoName, `${i}`.padEnd(40, "a"), status);
    }
    // ...and green on the commit actually being landed.
    await report(repoName, headSha, "success");

    // 5 successes in 7 → 95% Wilson lower bound ≈ 0.409, under min_pass_rate 0.6.
    const blocked = await api(`/api/v3/repos/${owner}/${repoName}/pulls/${number}/merge`, {
      method: "PUT",
      body: "{}",
    });
    expect(blocked.status).toBe(422);
    const unmet = (blocked.body as { unmet: string[] }).unmet.join(" ");
    expect(unmet).toMatch(/gates_confident/);
    expect(unmet).toMatch(/lower bound/);

    // Accumulate a run of successes; the bound rises past the threshold.
    for (let i = 0; i < 15; i++) {
      await report(repoName, `${i}`.padEnd(40, "b"), "success");
    }
    const allowed = await api(`/api/v3/repos/${owner}/${repoName}/pulls/${number}/merge`, {
      method: "PUT",
      body: "{}",
    });
    expect(allowed.status).toBe(200);
  }, 120_000);

  it("gates_confident falls back to gates_green below min_runs rather than failing closed on thin data", async () => {
    const repoName = "thin-data";
    const { headSha, number } = await setupRepo(
      repoName,
      "gates:\n  - tests\nland:\n  require:\n    - gates_confident\n  statistical:\n    min_runs: 10\n    min_pass_rate: 0.99\n",
    );

    // One observation only. min_pass_rate 0.99 is unreachable at n=1 for any
    // interval, so a naive implementation would block forever — the fallback is
    // what stops a brand-new gate from being permanently unlandable.
    await report(repoName, headSha, "success");

    const res = await api(`/api/v3/repos/${owner}/${repoName}/pulls/${number}/merge`, { method: "PUT", body: "{}" });
    expect(res.status).toBe(200);
  }, 120_000);

  it("quarantines a self-contradicting gate: it stops blocking, and the quarantine is recorded", async () => {
    const repoName = "flaky";
    const { headSha, number } = await setupRepo(
      repoName,
      "gates:\n  - tests\nland:\n  require:\n    - gates_green\n  statistical:\n    quarantine_threshold: 0.2\n",
    );

    // Three commits that each reported both success and failure — the gate
    // disagreeing with itself, which is exactly what "flaky" means here.
    for (let i = 0; i < 3; i++) {
      const sha = `${i}`.padEnd(40, "c");
      await report(repoName, sha, "success");
      await report(repoName, sha, "failure");
    }
    // Flake rate is 3/4 once the head commit is counted, well over 0.2.
    // The gate is *failing* on the commit being landed.
    await report(repoName, headSha, "failure");

    const res = await api(`/api/v3/repos/${owner}/${repoName}/pulls/${number}/merge`, { method: "PUT", body: "{}" });
    // A red gate that would normally block: quarantine is what lets this land.
    expect(res.status).toBe(200);

    // ...and it is on the record. A gate that silently stopped mattering is the
    // one outcome this feature is not allowed to have.
    const repo = await findRepo(db, owner, repoName);
    const ops = await db.select().from(operations).where(eq(operations.repoId, repo!.id));
    const quarantineOps = ops.filter((o) => o.verb === "gate.quarantine");
    expect(quarantineOps).toHaveLength(1);
    const after = quarantineOps[0]!.after as { gate: string; flakeRate: number; latestStatus: string };
    expect(after.gate).toBe("tests");
    expect(after.flakeRate).toBeGreaterThan(0.2);
    // The gate's real verdict is preserved, not rewritten to look green.
    expect(after.latestStatus).toBe("failure");
  }, 120_000);

  it("a consistently failing gate is not quarantined — failing is not the same as flaky", async () => {
    const repoName = "consistently-red";
    const { headSha, number } = await setupRepo(
      repoName,
      "gates:\n  - tests\nland:\n  require:\n    - gates_green\n  statistical:\n    quarantine_threshold: 0.2\n",
    );

    // Fails every time, on distinct commits, never contradicting itself.
    for (let i = 0; i < 5; i++) await report(repoName, `${i}`.padEnd(40, "d"), "failure");
    await report(repoName, headSha, "failure");

    const res = await api(`/api/v3/repos/${owner}/${repoName}/pulls/${number}/merge`, { method: "PUT", body: "{}" });
    expect(res.status).toBe(422);
    expect((res.body as { unmet: string[] }).unmet.join(" ")).toMatch(/gates_green/);

    const repo = await findRepo(db, owner, repoName);
    const ops = await db.select().from(operations).where(eq(operations.repoId, repo!.id));
    expect(ops.filter((o) => o.verb === "gate.quarantine")).toHaveLength(0);
  }, 120_000);
});
