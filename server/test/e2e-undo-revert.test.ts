import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { identities, gateJobs } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { repoAccessCheck } from "../src/core/repos-lookup.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerProposalRoutes } from "../src/http-rest/proposals.js";
import { registerOperationRoutes } from "../src/http-rest/operations.js";
import { registerGateRoutes } from "../src/http-rest/gates.js";

const execFileAsync = promisify(execFile);

// #159. Undo covered one case: winding the base ref back with the same
// compare-and-swap the merge used, available only while the ref still points
// where the merge left it. That precondition is what makes a rollback exact —
// nothing else landed, so nothing else is lost — and it also meant undo worked
// right up until somebody else pushed, which on any active repository is
// minutes.
//
// The second path produces the change that takes the merge back out on top of
// whatever landed since. What this suite pins down is that it is a *change*
// rather than a privileged edit to history: it opens a proposal, that proposal
// is subject to the same land policy as everything else, and the operation log
// can tell the two paths apart.
describe.skipIf(skipWithoutDb)("#159: compensating-revert undo", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let gitBackend: GitBackend;
  let port: number;
  let token: string;
  let reviewerToken: string;
  const owner = `revert-owner-${Date.now()}`;

  async function api(pathAndQuery: string, init: RequestInit = {}, as = token) {
    const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${as}`,
        "Content-Type": "application/json",
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
    return { status: res.status, body: body as Record<string, never> };
  }

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, {
      migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
    });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-revert-git-"));
    gitBackend = new GitBackend(gitRoot);
    const signer = new Signer("e2e-revert-signing-key");

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      [
        "application/x-git-upload-pack-request",
        "application/x-git-receive-pack-request",
      ],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    // A real instance floor, unlike e2e-operations.test.ts's empty one: the
    // whole question here is whether a revert is subject to the policy, and a
    // suite with no policy could not tell.
    registerProposalRoutes(app, db, gitBackend, "e2e-test-credential-key", [
      "gates_green",
    ]);
    registerGateRoutes(
      app,
      db,
      signer,
      "https://adp.example.com",
      "e2e-test-credential-key",
    );
    registerOperationRoutes(app, db, gitBackend);
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;
    gitBackend.setInternalUrl(`http://127.0.0.1:${port}`);

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `revert-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, [
      "repo:read",
      "repo:write",
      "admin",
    ]);
    await grantOwner(db, identity!.id, owner);

    const [reviewer] = await db
      .insert(identities)
      .values({ kind: "human", principal: `revert-e2e-reviewer-${Date.now()}` })
      .returning();
    reviewerToken = await mintToken(db, reviewer!.id, [
      "repo:read",
      "repo:write",
    ]);
    await grantOwner(db, reviewer!.id, owner);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  // Seeds a repo, lands one proposal, then pushes something else on top so the
  // base ref has moved — the state every test below starts from, because it is
  // the state in which the old undo had nothing to offer.
  async function repoWithMovedBranch(
    repoName: string,
    seed: { file: string; content: string }[],
    feature: { file: string; content: string }[],
    later: { file: string; content: string }[],
    adpYaml?: string,
  ) {
    await api(`/api/v3/repos/${owner}`, {
      method: "POST",
      body: JSON.stringify({ name: repoName }),
    });
    const dir = await mkdtemp(
      path.join(tmpdir(), `adp-e2e-revert-${repoName}-`),
    );
    try {
      return await seedIn(dir);
    } finally {
      // In a `finally`, because an assertion inside leaves the clone behind
      // otherwise — which `verify-clean.sh` reports as a stale temp directory
      // long after the run that made it, blaming whoever looks next.
      await rm(dir, { recursive: true, force: true });
    }

    async function seedIn(dir: string) {
      const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
      await execFileAsync("git", ["clone", cloneUrl, dir]);
      await execFileAsync("git", ["checkout", "-B", "main"], { cwd: dir });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], {
        cwd: dir,
      });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });

      const write = async (files: { file: string; content: string }[]) => {
        for (const f of files) {
          await execFileAsync(
            "sh",
            ["-c", `printf '%b' ${JSON.stringify(f.content)} > ${f.file}`],
            { cwd: dir },
          );
        }
        await execFileAsync("git", ["add", "-A"], { cwd: dir });
      };

      if (adpYaml)
        await execFileAsync(
          "sh",
          ["-c", `printf '%b' ${JSON.stringify(adpYaml)} > adp.yaml`],
          { cwd: dir },
        );
      await write(seed);
      await execFileAsync("git", ["commit", "-m", "seed"], { cwd: dir });
      await execFileAsync("git", ["push", "origin", "main"], { cwd: dir });

      await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: dir });
      await write(feature);
      await execFileAsync(
        "git",
        ["commit", "-m", "the change we will regret"],
        { cwd: dir },
      );
      await execFileAsync("git", ["push", "origin", "feature"], { cwd: dir });
      const featureSha = (
        await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir })
      ).stdout.trim();

      const created = await api(`/api/v3/repos/${owner}/${repoName}/pulls`, {
        method: "POST",
        body: JSON.stringify({
          title: "Ship the thing",
          head: "feature",
          base: "main",
        }),
      });
      const number = (created.body as unknown as { number: number }).number;

      // Satisfy the floor so it can land in the first place.
      await api(`/api/v3/repos/${owner}/${repoName}/gates`, {
        method: "POST",
        body: JSON.stringify({
          git_sha: featureSha,
          name: "tests",
          status: "success",
          summary: "green",
        }),
      });
      const merged = await api(
        `/api/v3/repos/${owner}/${repoName}/pulls/${number}/merge`,
        {
          method: "PUT",
          body: "{}",
        },
      );
      expect(merged.status).toBe(200);

      // And now somebody else lands on main, which is what closes the rollback
      // path for good.
      await execFileAsync("git", ["checkout", "main"], { cwd: dir });
      await execFileAsync("git", ["pull", "origin", "main"], { cwd: dir });
      await write(later);
      await execFileAsync("git", ["commit", "-m", "later work"], { cwd: dir });
      await execFileAsync("git", ["push", "origin", "main"], { cwd: dir });
      const laterSha = (
        await execFileAsync("git", ["rev-parse", "main"], { cwd: dir })
      ).stdout.trim();

      const ops = await api(
        `/api/adp/repos/${owner}/${repoName}/operations?verb=proposal.merge`,
      );
      const mergeOp = (ops.body as unknown as { id: string }[])[0]!;
      return { repoName, number, mergeOp, laterSha, featureSha };
    }
  }

  it("opens a revert proposal when the branch has moved, and leaves the branch alone", async () => {
    const { repoName, number, mergeOp, laterSha } = await repoWithMovedBranch(
      "moved",
      [{ file: "README.md", content: "seed\n" }],
      [{ file: "feature.txt", content: "the regrettable thing\n" }],
      [{ file: "other.txt", content: "unrelated later work\n" }],
    );

    const undone = await api(
      `/api/adp/repos/${owner}/${repoName}/operations/${mergeOp.id}/undo`,
      {
        method: "POST",
        body: "{}",
      },
    );
    expect(undone.status).toBe(200);

    const body = undone.body as unknown as {
      verb: string;
      parent_op: string;
      undo_path: string;
      proposal: {
        number: number;
        head_ref: string;
        head_sha: string;
        base_ref: string;
        state: string;
      };
    };
    expect(body.undo_path).toBe("revert");
    // The log distinguishes a rollback from a revert. They are different facts
    // about history and a query that cannot tell them apart is reading the log
    // wrong.
    expect(body.verb).toBe("proposal.merge.revert");
    expect(body.parent_op).toBe(mergeOp.id);

    expect(body.proposal.state).toBe("open");
    expect(body.proposal.head_ref).toBe(`adp/revert-${number}`);
    expect(body.proposal.base_ref).toBe("main");

    // Nothing moved. The undo produced a change, not an edit to history — which
    // is the entire difference between this path and a rollback.
    expect(await gitBackend.resolveRef(owner, repoName, "main")).toBe(laterSha);
    expect(
      await gitBackend.resolveRef(owner, repoName, body.proposal.head_ref),
    ).toBe(body.proposal.head_sha);

    // And the revert commit takes the merge out while keeping what landed
    // after it — the property that makes it a compensating revert rather than a
    // rollback with extra steps.
    expect(
      await gitBackend.statPath(
        owner,
        repoName,
        body.proposal.head_sha,
        "feature.txt",
      ),
    ).toBeNull();
    expect(
      await gitBackend.statPath(
        owner,
        repoName,
        body.proposal.head_sha,
        "other.txt",
      ),
    ).not.toBeNull();
  });

  it("subjects the revert to the same land policy, and lands it once the gate is green", async () => {
    // The repo has to name a gate: `gates_green` on a repo that declares none
    // is satisfied vacuously, so a suite without this would assert that the
    // policy applies while testing a policy with nothing in it.
    const { repoName, mergeOp } = await repoWithMovedBranch(
      "policy",
      [{ file: "README.md", content: "seed\n" }],
      [{ file: "feature.txt", content: "the regrettable thing\n" }],
      [{ file: "other.txt", content: "unrelated later work\n" }],
      "gates:\n  - tests\nland:\n  require: []\n",
    );

    const undone = await api(
      `/api/adp/repos/${owner}/${repoName}/operations/${mergeOp.id}/undo`,
      {
        method: "POST",
        body: "{}",
      },
    );
    const proposal = (
      undone.body as unknown as {
        proposal: { number: number; head_sha: string };
      }
    ).proposal;

    // The gate is the point. An undo path that bypassed the policy would be a
    // hole in the gate, opened by the verb most likely to be used in a hurry.
    const blocked = await api(
      `/api/v3/repos/${owner}/${repoName}/pulls/${proposal.number}/merge`,
      {
        method: "PUT",
        body: "{}",
      },
    );
    expect(blocked.status).toBe(422);
    expect(
      (blocked.body as unknown as { unmet: string[] }).unmet.join(" "),
    ).toMatch(/gates_green/);

    await api(`/api/v3/repos/${owner}/${repoName}/gates`, {
      method: "POST",
      body: JSON.stringify({
        git_sha: proposal.head_sha,
        name: "tests",
        status: "success",
        summary: "green",
      }),
    });
    const landed = await api(
      `/api/v3/repos/${owner}/${repoName}/pulls/${proposal.number}/merge`,
      {
        method: "PUT",
        body: "{}",
      },
    );
    expect(landed.status).toBe(200);

    // Only now is the change actually out of the branch, which is why
    // `undo_path: revert` means "here is the change that undoes it" and not
    // "it is undone".
    const head = (await gitBackend.resolveRef(owner, repoName, "main"))!;
    expect(
      await gitBackend.statPath(owner, repoName, head, "feature.txt"),
    ).toBeNull();
    expect(
      await gitBackend.statPath(owner, repoName, head, "other.txt"),
    ).not.toBeNull();
  });

  it("enqueues the revert's own gates, so the policy it must satisfy is satisfiable", async () => {
    const adpYaml =
      "gates:\n  - tests\nland:\n  require: []\nrunner:\n  image: node:22\n  gates:\n    - name: tests\n      run: 'true'\n";
    const { repoName, mergeOp } = await repoWithMovedBranch(
      "gatejobs",
      [{ file: "README.md", content: "seed\n" }],
      [{ file: "feature.txt", content: "regret\n" }],
      [{ file: "other.txt", content: "later\n" }],
      adpYaml,
    );

    const undone = await api(
      `/api/adp/repos/${owner}/${repoName}/operations/${mergeOp.id}/undo`,
      {
        method: "POST",
        body: "{}",
      },
    );
    const body = undone.body as unknown as {
      gate_jobs_enqueued: number;
      proposal: { head_sha: string };
    };
    expect(body.gate_jobs_enqueued).toBe(1);

    // A proposal nothing will ever report a gate result for is a refusal
    // wearing the shape of a fix, so the job exists rather than the intention
    // to create one.
    const queued = await db
      .select()
      .from(gateJobs)
      .where(
        and(
          eq(gateJobs.gitSha, body.proposal.head_sha),
          eq(gateJobs.name, "tests"),
        ),
      );
    expect(queued).toHaveLength(1);
    expect(queued[0]!.status).toBe("queued");
  });

  it("refuses a conflicting revert with the paths named, rather than producing a broken tree", async () => {
    // The later work edits the same file the merge introduced, so undoing the
    // merge cannot be done without deciding what to do about it.
    const { repoName, mergeOp } = await repoWithMovedBranch(
      "conflict",
      [{ file: "README.md", content: "seed\n" }],
      [{ file: "shared.txt", content: "one\n" }],
      [{ file: "shared.txt", content: "one\ntwo\n" }],
    );

    const undone = await api(
      `/api/adp/repos/${owner}/${repoName}/operations/${mergeOp.id}/undo`,
      {
        method: "POST",
        body: "{}",
      },
    );
    expect(undone.status).toBe(422);
    const body = undone.body as unknown as {
      message: string;
      conflicts: string[];
    };
    expect(body.message).toMatch(/conflicts with what landed after it/);
    // Named, because "it conflicts" is not actionable and "it conflicts in
    // shared.txt" is.
    expect(body.conflicts).toEqual(["shared.txt"]);

    // Nothing was created on the way to refusing.
    const proposals = await api(
      `/api/v3/repos/${owner}/${repoName}/pulls?state=all`,
    );
    expect((proposals.body as unknown as unknown[]).length).toBe(1);
    expect(
      await gitBackend.resolveRef(owner, repoName, "adp/revert-1"),
    ).toBeNull();
  });

  it("refuses a second undo of the same merge, whichever path the first took", async () => {
    const { repoName, mergeOp } = await repoWithMovedBranch(
      "twice",
      [{ file: "README.md", content: "seed\n" }],
      [{ file: "feature.txt", content: "regret\n" }],
      [{ file: "other.txt", content: "later\n" }],
    );

    const first = await api(
      `/api/adp/repos/${owner}/${repoName}/operations/${mergeOp.id}/undo`,
      {
        method: "POST",
        body: "{}",
      },
    );
    expect(first.status).toBe(200);

    const second = await api(
      `/api/adp/repos/${owner}/${repoName}/operations/${mergeOp.id}/undo`,
      {
        method: "POST",
        body: "{}",
      },
    );
    expect(second.status).toBe(422);
    expect((second.body as unknown as { message: string }).message).toMatch(
      /already been undone/,
    );
  });

  it("refuses when the merge is no longer in the branch's history at all", async () => {
    const { repoName, mergeOp } = await repoWithMovedBranch(
      "rewritten",
      [{ file: "README.md", content: "seed\n" }],
      [{ file: "feature.txt", content: "regret\n" }],
      [{ file: "other.txt", content: "later\n" }],
    );

    // Somebody rewrote main out from under the record — the merge is gone, so
    // reverting it would remove something a second time or nothing at all.
    const seedSha = (await gitBackend.log(owner, repoName, "main", 100)).at(
      -1,
    )!.sha;
    await gitBackend.createRef(owner, repoName, "refs/heads/main", seedSha);

    const undone = await api(
      `/api/adp/repos/${owner}/${repoName}/operations/${mergeOp.id}/undo`,
      {
        method: "POST",
        body: "{}",
      },
    );
    expect(undone.status).toBe(422);
    expect((undone.body as unknown as { message: string }).message).toMatch(
      /history was rewritten/,
    );
  });

  it("still prefers the exact path: an untouched branch is rolled back, not reverted", async () => {
    const repoName = "untouched";
    await api(`/api/v3/repos/${owner}`, {
      method: "POST",
      body: JSON.stringify({ name: repoName }),
    });
    const dir = await mkdtemp(path.join(tmpdir(), "adp-e2e-revert-untouched-"));
    let featureSha = "";
    let baseBefore = "";
    try {
      const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
      await execFileAsync("git", ["clone", cloneUrl, dir]);
      await execFileAsync("git", ["checkout", "-B", "main"], { cwd: dir });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], {
        cwd: dir,
      });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
      await execFileAsync("sh", ["-c", "printf 'seed\\n' > README.md"], {
        cwd: dir,
      });
      await execFileAsync("git", ["add", "-A"], { cwd: dir });
      await execFileAsync("git", ["commit", "-m", "seed"], { cwd: dir });
      await execFileAsync("git", ["push", "origin", "main"], { cwd: dir });
      baseBefore = (
        await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir })
      ).stdout.trim();

      await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: dir });
      await execFileAsync("sh", ["-c", "printf 'x\\n' > feature.txt"], {
        cwd: dir,
      });
      await execFileAsync("git", ["add", "-A"], { cwd: dir });
      await execFileAsync("git", ["commit", "-m", "feature"], { cwd: dir });
      await execFileAsync("git", ["push", "origin", "feature"], { cwd: dir });
      featureSha = (
        await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir })
      ).stdout.trim();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const created = await api(`/api/v3/repos/${owner}/${repoName}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: "Ship", head: "feature", base: "main" }),
    });
    const number = (created.body as unknown as { number: number }).number;
    await api(`/api/v3/repos/${owner}/${repoName}/gates`, {
      method: "POST",
      body: JSON.stringify({
        git_sha: featureSha,
        name: "tests",
        status: "success",
        summary: "green",
      }),
    });
    await api(`/api/v3/repos/${owner}/${repoName}/pulls/${number}/merge`, {
      method: "PUT",
      body: "{}",
    });

    const ops = await api(
      `/api/adp/repos/${owner}/${repoName}/operations?verb=proposal.merge`,
    );
    const mergeOp = (ops.body as unknown as { id: string }[])[0]!;
    const undone = await api(
      `/api/adp/repos/${owner}/${repoName}/operations/${mergeOp.id}/undo`,
      {
        method: "POST",
        body: "{}",
      },
    );

    expect(undone.status).toBe(200);
    const body = undone.body as unknown as {
      undo_path: string;
      verb: string;
      proposal?: unknown;
    };
    // Rollback is exact and leaves no trace of the mistake; a revert is a
    // second commit in the history forever. When both are available the exact
    // one wins.
    expect(body.undo_path).toBe("rollback");
    expect(body.verb).toBe("proposal.merge.undo");
    expect(body.proposal).toBeUndefined();
    expect(await gitBackend.resolveRef(owner, repoName, "main")).toBe(
      baseBefore,
    );
  });
});
