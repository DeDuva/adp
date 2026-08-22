import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { identities, operations, proposals, workspaces, candidateSets } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { findRepo } from "../src/core/repos-lookup.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { repoAccessCheck } from "../src/core/repos-lookup.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerIssueRoutes } from "../src/http-rest/issues.js";
import { registerChangeRoutes } from "../src/http-rest/changes.js";
import { registerProposalRoutes } from "../src/http-rest/proposals.js";
import { registerGateRoutes } from "../src/http-rest/gates.js";
import { registerWorkspaceRoutes } from "../src/http-rest/workspaces.js";
import { registerCandidateSetRoutes } from "../src/http-rest/candidate-sets.js";

const execFileAsync = promisify(execFile);
const SIGNING_KEY = "e2e-fanout-signing-key";
const CREDENTIAL_KEY = "e2e-fanout-credential-key";
const PUBLIC_URL = "https://adp.example.com";

// M3 / D1 (docs/adp-prototype-implementation-plan.md §5, docs/m3-readiness-review.md M3-2):
// "fork 50 workspaces … dispatch the same task … land the winner with its
// evidence bundle, GC the rest. The money shot is the history view: one landed
// change, intent attached, 49 discarded attempts queryable but not polluting
// history."
//
// Fan-out here is genuinely concurrent rather than a loop dressed up as one —
// 50 simultaneous workspace creations mean 50 simultaneous ref writes into one
// bare repo, which is the first time this code sees that kind of contention and
// is exactly what the milestone claims to support.
describe.skipIf(skipWithoutDb)("M3: candidate-set fan-out, resolution, and reclamation (D1)", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let gitBackend: GitBackend;
  let signer: Signer;
  let port: number;
  let token: string;
  let mainSha: string;
  const owner = `fanout-owner-${Date.now()}`;
  const repoName = "widget";

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

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-fanout-git-"));
    gitBackend = new GitBackend(gitRoot);
    signer = new Signer(SIGNING_KEY);

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, PUBLIC_URL);
    registerIssueRoutes(app, db);
    registerChangeRoutes(app, db, gitBackend, signer);
    registerProposalRoutes(app, db, gitBackend, CREDENTIAL_KEY, []);
    registerGateRoutes(app, db, signer, PUBLIC_URL, CREDENTIAL_KEY);
    registerWorkspaceRoutes(app, db, gitBackend);
    registerCandidateSetRoutes(app, db, gitBackend, []);
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;
    gitBackend.setInternalUrl(`http://127.0.0.1:${port}`);

    const [identity] = await db
      .insert(identities)
      .values({ kind: "agent", principal: `fanout-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);

    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: repoName }) });

    // One real commit on main so candidates have something to fork from.
    const seed = await mkdtemp(path.join(tmpdir(), "adp-e2e-fanout-seed-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, seed]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: seed });
    await execFileAsync("git", ["config", "user.email", "seed@example.com"], { cwd: seed });
    await execFileAsync("git", ["config", "user.name", "Seed"], { cwd: seed });
    await writeFile(path.join(seed, "README.md"), "seed\n");
    await execFileAsync("git", ["add", "."], { cwd: seed });
    await execFileAsync("git", ["commit", "-m", "seed"], { cwd: seed });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: seed });
    mainSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: seed })).stdout.trim();
    await rm(seed, { recursive: true, force: true });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  // Each candidate is a real commit on its own workspace branch. Built through
  // the git backend rather than 50 clone/push round-trips — the object graph is
  // identical and the test stays a test rather than a benchmark.
  async function fanOut(count: number, candidateSetId: string, baseSha: string) {
    const created = await Promise.all(
      Array.from({ length: count }, async (_unused, i) => {
        const ws = await api(`/api/adp/repos/${owner}/${repoName}/workspaces`, {
          method: "POST",
          body: JSON.stringify({ base_ref: "main" }),
        });
        expect(ws.status).toBe(201);
        const branch = ws.body.branch as string;

        const tree = await gitBackend.statPath(owner, repoName, baseSha, "");
        const sha = await gitBackend.createCommit(
          owner,
          repoName,
          tree!.sha,
          [baseSha],
          `candidate ${i}`,
          { name: "agent", email: "agent@adp.local" },
        );
        await gitBackend.fastForwardRef(owner, repoName, branch, baseSha, sha);

        const proposal = await api(`/api/v3/repos/${owner}/${repoName}/pulls`, {
          method: "POST",
          body: JSON.stringify({
            title: `candidate ${i}`,
            head: branch,
            base: "main",
            candidate_set_id: candidateSetId,
          }),
        });
        expect(proposal.status).toBe(201);
        return { index: i, branch, sha, proposalId: proposal.body.id as string, workspaceId: ws.body.id as string };
      }),
    );
    return created;
  }

  async function reportScore(sha: string, score: number) {
    const res = await api(`/api/v3/repos/${owner}/${repoName}/gates`, {
      method: "POST",
      body: JSON.stringify({ name: "score", status: "success", summary: `score ${score}`, git_sha: sha, score }),
    });
    expect(res.status).toBe(201);
  }

  it(
    "50-way fan-out resolves to exactly one landed change, with the other 49 reclaimed but still queryable",
    async () => {
      const FAN_OUT = 50;

      const issue = await api(`/api/v3/repos/${owner}/${repoName}/issues`, {
        method: "POST",
        body: JSON.stringify({ title: "make the widget faster" }),
      });
      expect(issue.status).toBe(201);
      const intentId = issue.body.intent_id as string;

      const set = await api(`/api/adp/repos/${owner}/${repoName}/candidate-sets`, {
        method: "POST",
        body: JSON.stringify({ intent_id: intentId, selection_policy: "best_score" }),
      });
      expect(set.status).toBe(201);
      const candidateSetId = set.body.id as string;

      const candidates = await fanOut(FAN_OUT, candidateSetId, mainSha);
      expect(candidates).toHaveLength(FAN_OUT);
      // 50 concurrent ref writes into one bare repo produced 50 distinct
      // branches — no lost update, which is the contention claim under D1.
      expect(new Set(candidates.map((c) => c.branch)).size).toBe(FAN_OUT);

      // Scores ascending by index, so the *last* candidate wins — a winner that
      // isn't also "the first one" or "the selected one" is the only way to
      // tell best_score apart from a fallback.
      for (const candidate of candidates) await reportScore(candidate.sha, candidate.index);
      const expectedWinner = candidates[FAN_OUT - 1]!;

      const resolved = await api(`/api/adp/repos/${owner}/${repoName}/candidate-sets/${candidateSetId}/resolve`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(resolved.status).toBe(200);
      expect(resolved.body.status).toBe("resolved");
      expect((resolved.body.landed as { proposal_id: string }).proposal_id).toBe(expectedWinner.proposalId);
      expect(resolved.body.reclaimed).toHaveLength(FAN_OUT - 1);

      const repo = await findRepo(db, owner, repoName);
      const rows = await db
        .select()
        .from(proposals)
        .where(and(eq(proposals.repoId, repo!.id), eq(proposals.candidateSetId, candidateSetId)));

      expect(rows.filter((r) => r.state === "merged")).toHaveLength(1);
      expect(rows.filter((r) => r.state === "closed")).toHaveLength(FAN_OUT - 1);
      // "Queryable but not polluting history": every attempt still has a row.
      expect(rows).toHaveLength(FAN_OUT);

      // The losers' refs are gone; the winner's landed on main.
      const wsRows = await db.select().from(workspaces).where(eq(workspaces.repoId, repo!.id));
      const destroyed = wsRows.filter((w) => w.destroyedAt !== null);
      expect(destroyed).toHaveLength(FAN_OUT - 1);
      for (const loser of candidates.filter((c) => c.proposalId !== expectedWinner.proposalId)) {
        expect(await gitBackend.resolveRef(owner, repoName, loser.branch)).toBeNull();
      }

      // Squash: main advanced by exactly one commit carrying the winner's tree.
      const newMain = await gitBackend.resolveRef(owner, repoName, "main");
      expect(newMain).not.toBe(mainSha);
      const log = await gitBackend.log(owner, repoName, `${mainSha}..${newMain}`, 10);
      expect(log).toHaveLength(1);

      // Every reclamation is in the op log, and so is the resolution itself —
      // reclaiming 49 workspaces without a record would be a GC that erased its
      // own evidence.
      const ops = await db.select().from(operations).where(eq(operations.repoId, repo!.id));
      expect(ops.filter((o) => o.verb === "candidateset.reclaim")).toHaveLength(FAN_OUT - 1);
      expect(ops.filter((o) => o.verb === "candidateset.resolve")).toHaveLength(1);
      expect(ops.filter((o) => o.verb === "workspace.destroy")).toHaveLength(FAN_OUT - 1);

      const [setRow] = await db.select().from(candidateSets).where(eq(candidateSets.id, candidateSetId));
      expect(setRow!.selectedProposalId).toBe(expectedWinner.proposalId);
      expect(setRow!.resolvedAt).not.toBeNull();

      // The comparison view's read path (M3-6). The list makes a set reachable
      // without already knowing its id, and the detail carries the evidence that
      // decided the outcome — score and gates per candidate — because a view
      // showing only that one candidate won, without why, would make a 50-way
      // fan-out indistinguishable from a single proposal.
      const list = await api(`/api/adp/repos/${owner}/${repoName}/candidate-sets`);
      expect(list.status).toBe(200);
      const summaries = list.body as unknown as { id: string; status: string; candidate_count: number }[];
      const summary = summaries.find((s) => s.id === candidateSetId);
      expect(summary).toBeTruthy();
      expect(summary!.status).toBe("resolved");
      expect(summary!.candidate_count).toBe(FAN_OUT);

      const detail = await api(`/api/adp/repos/${owner}/${repoName}/candidate-sets/${candidateSetId}`);
      expect(detail.status).toBe(200);
      const detailCandidates = detail.body.candidates as {
        id: string;
        state: string;
        head_sha: string;
        score: number | null;
        gates: { name: string; status: string }[];
      }[];
      expect(detailCandidates).toHaveLength(FAN_OUT);
      const winnerRow = detailCandidates.find((c) => c.id === expectedWinner.proposalId)!;
      expect(winnerRow.state).toBe("merged");
      expect(winnerRow.score).toBe(FAN_OUT - 1);
      expect(winnerRow.gates.map((g) => g.name)).toContain("score");
      // Losers keep their evidence — that is what "queryable but not polluting
      // history" has to mean for the view to be worth having.
      expect(detailCandidates.filter((c) => c.score !== null)).toHaveLength(FAN_OUT);
    },
    300_000,
  );

  it("refuses to resolve a 'manual' set that has no selection, rather than guessing", async () => {
    const issue = await api(`/api/v3/repos/${owner}/${repoName}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: "manual set" }),
    });
    const intentId = issue.body.intent_id as string;

    const set = await api(`/api/adp/repos/${owner}/${repoName}/candidate-sets`, {
      method: "POST",
      body: JSON.stringify({ intent_id: intentId, selection_policy: "manual" }),
    });
    const candidateSetId = set.body.id as string;

    const baseSha = (await gitBackend.resolveRef(owner, repoName, "main"))!;
    const candidates = await fanOut(2, candidateSetId, baseSha);

    const unselected = await api(`/api/adp/repos/${owner}/${repoName}/candidate-sets/${candidateSetId}/resolve`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(unselected.status).toBe(422);
    expect(unselected.body.message).toContain("requires an explicit selection");

    // Nothing was landed or reclaimed by the refusal.
    const repo = await findRepo(db, owner, repoName);
    const stillOpen = await db
      .select()
      .from(proposals)
      .where(and(eq(proposals.repoId, repo!.id), eq(proposals.candidateSetId, candidateSetId)));
    expect(stillOpen.every((p) => p.state === "open")).toBe(true);

    // Select, then resolve — and the selected candidate is the one that lands.
    const select = await api(`/api/adp/repos/${owner}/${repoName}/candidate-sets/${candidateSetId}/select`, {
      method: "POST",
      body: JSON.stringify({ proposal_id: candidates[1]!.proposalId }),
    });
    expect(select.status).toBe(200);

    const resolved = await api(`/api/adp/repos/${owner}/${repoName}/candidate-sets/${candidateSetId}/resolve`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(resolved.status).toBe(200);
    expect((resolved.body.landed as { proposal_id: string }).proposal_id).toBe(candidates[1]!.proposalId);
  }, 120_000);

  // Resolving is three steps that cannot be one transaction — land the winner
  // (git *and* Postgres), reclaim the losers, mark the set resolved. An
  // interruption between the first and the last leaves a set that is still
  // `open` while already having a merged candidate, which is what this
  // simulates by rolling the set's status back after a successful resolve.
  //
  // Re-entering must complete that resolution, not go land a second candidate.
  // The fast-forward precondition would in fact refuse a second land — no loser
  // is a descendant of the moved base — so the "one landed change" invariant
  // held even before this. But it held by accident of another check, the caller
  // got an opaque 409, and the set stayed open with its losers unreclaimed.
  it("completes an interrupted resolution instead of landing a second candidate", async () => {
    const issue = await api(`/api/v3/repos/${owner}/${repoName}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: "interrupted" }),
    });
    const set = await api(`/api/adp/repos/${owner}/${repoName}/candidate-sets`, {
      method: "POST",
      body: JSON.stringify({ intent_id: issue.body.intent_id, selection_policy: "first_green" }),
    });
    const candidateSetId = set.body.id as string;

    const baseSha = (await gitBackend.resolveRef(owner, repoName, "main"))!;
    const candidates = await fanOut(3, candidateSetId, baseSha);

    const first = await api(`/api/adp/repos/${owner}/${repoName}/candidate-sets/${candidateSetId}/resolve`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(first.status).toBe(200);
    const landedId = (first.body.landed as { proposal_id: string }).proposal_id;
    const mainAfterFirst = await gitBackend.resolveRef(owner, repoName, "main");

    // Rewind only the set's own bookkeeping, leaving the merged candidate and
    // the closed losers as they are — exactly the state a crash after the land
    // would leave behind.
    await db
      .update(candidateSets)
      .set({ status: "open", resolvedAt: null, selectedProposalId: null })
      .where(eq(candidateSets.id, candidateSetId));
    const repo = await findRepo(db, owner, repoName);
    await db
      .update(proposals)
      .set({ state: "open", closedAt: null })
      .where(and(eq(proposals.repoId, repo!.id), eq(proposals.candidateSetId, candidateSetId), eq(proposals.state, "closed")));

    const second = await api(`/api/adp/repos/${owner}/${repoName}/candidate-sets/${candidateSetId}/resolve`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(second.status).toBe(200);

    // The same candidate is still the winner, and nothing new landed: main is
    // exactly where the first resolve left it.
    expect((second.body.landed as { proposal_id: string }).proposal_id).toBe(landedId);
    expect(await gitBackend.resolveRef(owner, repoName, "main")).toBe(mainAfterFirst);
    // `sha` is null because the land belonged to the interrupted call.
    expect((second.body.landed as { sha: string | null }).sha).toBeNull();

    const rows = await db
      .select()
      .from(proposals)
      .where(and(eq(proposals.repoId, repo!.id), eq(proposals.candidateSetId, candidateSetId)));
    expect(rows.filter((r) => r.state === "merged")).toHaveLength(1);
    expect(rows.filter((r) => r.state === "closed")).toHaveLength(candidates.length - 1);
  }, 120_000);

  it("a resolved set cannot resolve twice", async () => {
    const issue = await api(`/api/v3/repos/${owner}/${repoName}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: "double resolve" }),
    });
    const intentId = issue.body.intent_id as string;
    const set = await api(`/api/adp/repos/${owner}/${repoName}/candidate-sets`, {
      method: "POST",
      body: JSON.stringify({ intent_id: intentId, selection_policy: "first_green" }),
    });
    const candidateSetId = set.body.id as string;

    const baseSha = (await gitBackend.resolveRef(owner, repoName, "main"))!;
    await fanOut(2, candidateSetId, baseSha);

    const first = await api(`/api/adp/repos/${owner}/${repoName}/candidate-sets/${candidateSetId}/resolve`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(first.status).toBe(200);

    const second = await api(`/api/adp/repos/${owner}/${repoName}/candidate-sets/${candidateSetId}/resolve`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(second.status).toBe(422);
    expect(second.body.message).toContain("already resolved");
  }, 120_000);
});
