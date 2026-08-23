import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq, sql } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { identities, operations, sessionEvents } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { verifyEnvelope, decodeStatement, type DsseEnvelope } from "../src/core/dsse.js";
import { eventHash } from "../src/core/trajectory.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { repoAccessCheck } from "../src/core/repos-lookup.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerIssueRoutes } from "../src/http-rest/issues.js";
import { registerWorkspaceRoutes } from "../src/http-rest/workspaces.js";
import { registerOperationRoutes } from "../src/http-rest/operations.js";
import { registerSessionRoutes } from "../src/http-rest/sessions.js";
import { registerRunRoutes } from "../src/http-rest/runs.js";
import { registerGateRoutes } from "../src/http-rest/gates.js";
import { registerEvidenceRoutes } from "../src/http-rest/evidence.js";

const execFileAsync = promisify(execFile);
const SIGNING_KEY = "e2e-run-trajectory-signing-key";
const PUBLIC_URL = "https://adp.example.com";
const CREDENTIAL_KEY = "0".repeat(64);

// The vertical slice, stated as the capability it is meant to prove:
//
//   One orchestrator assignment creates an ADP run; each agent becomes an ADP
//   session; every message, model call, tool execution, handoff, commit, and
//   test result is durably appended; the run closes against a final Git SHA; a
//   deterministic eval result is attached to that run and reported as gate
//   evidence.
//
// The lesson applies directly: the check is not "does
// the criterion have a test" but "does the test exercise the scenario in the
// criterion's own words". So this walks a real multi-agent assignment against a
// real git repository over HTTP — all six event kinds, a handoff between two
// agent sessions, a real commit sha produced by a real push — rather than the
// neighbouring scenario that would have been easier to set up.
describe.skipIf(skipWithoutDb)("run trajectory and eval-gated close", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let workdir: string;
  let signer: Signer;
  let port: number;
  let token: string;
  let intentId: string;
  let runId: string;
  let finalSha: string;
  let comparedRuns: { first: string; second: string };
  let coordinatorSession: string;
  let backendSession: string;
  let testerSession: string;
  let actorPrincipal: string;
  let emitterSession: string;
  let emitterRun: string;
  const owner = `runs-owner-${Date.now()}`;
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
    return { status: res.status, body: body as Record<string, any> };
  }

  async function startSession(harness: string) {
    const res = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness, run_id: runId }),
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function append(sessionId: string, events: unknown[]) {
    return api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({ events }),
    });
  }

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-runs-git-"));
    const gitBackend = new GitBackend(gitRoot);
    signer = new Signer(SIGNING_KEY);

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, PUBLIC_URL);
    registerIssueRoutes(app, db);
    registerWorkspaceRoutes(app, db, gitBackend);
    registerOperationRoutes(app, db, gitBackend);
    registerSessionRoutes(app, db, gitBackend, signer, PUBLIC_URL);
    registerRunRoutes(app, db, gitBackend, signer, PUBLIC_URL);
    registerGateRoutes(app, db, signer, PUBLIC_URL, CREDENTIAL_KEY);
    registerEvidenceRoutes(app, db);
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;
    gitBackend.setInternalUrl(`http://127.0.0.1:${port}`);

    actorPrincipal = `runs-e2e-${Date.now()}`;
    const [identity] = await db
      .insert(identities)
      .values({ kind: "agent", principal: actorPrincipal })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);

    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: repoName }) });

    workdir = await mkdtemp(path.join(tmpdir(), "adp-e2e-runs-work-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, workdir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: workdir });
    await execFileAsync("git", ["config", "user.email", "agent@example.com"], { cwd: workdir });
    await execFileAsync("git", ["config", "user.name", "Agent"], { cwd: workdir });
    await writeFile(path.join(workdir, "README.md"), "seed\n");
    await execFileAsync("git", ["add", "."], { cwd: workdir });
    await execFileAsync("git", ["commit", "-m", "seed"], { cwd: workdir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: workdir });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (gitRoot) await rm(gitRoot, { recursive: true, force: true });
    if (workdir) await rm(workdir, { recursive: true, force: true });
  });

  // "One assignment creates an ADP run." The assignment arrives the way a real
  // orchestrator's does — as an issue — and ADP already turns every issue into
  // an intent, so the run has a stated goal without anyone inventing one.
  it("opens a run for an assignment, and re-opening the same assignment rejoins it", async () => {
    const issue = await api(`/api/v3/repos/${owner}/${repoName}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: "Add a greeting module", body: "with tests" }),
    });
    expect(issue.status).toBe(201);
    intentId = issue.body.intent_id;
    expect(intentId).toBeTruthy();

    const opened = await api(`/api/adp/repos/${owner}/${repoName}/runs`, {
      method: "POST",
      body: JSON.stringify({
        intent_id: intentId,
        orchestrator: "squad",
        external_ref: `issue:${issue.body.number}`,
        labels: { provider: "anthropic", model: "claude-sonnet-5" },
      }),
    });
    expect(opened.status).toBe(201);
    runId = opened.body.id;
    expect(opened.body.status).toBe("open");
    // What the run was, recorded at open. A comparison across vendors needs
    // this to be a field rather than something parsed out of `external_ref`,
    // whose format nothing enforces.
    expect(opened.body.labels).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });

    // An orchestrator that crashes and restarts must find the run it already
    // opened. A second run for one assignment would split the trajectory into
    // two halves that each look complete.
    const rejoined = await api(`/api/adp/repos/${owner}/${repoName}/runs`, {
      method: "POST",
      body: JSON.stringify({
        intent_id: intentId,
        orchestrator: "squad",
        external_ref: `issue:${issue.body.number}`,
        labels: { provider: "gemini", model: "gemini-flash-latest" },
      }),
    });
    expect(rejoined.status).toBe(200);
    expect(rejoined.body.id).toBe(runId);
    // Rejoining does not re-label. The attestation will describe the run that
    // already exists, so a retry that could rewrite what the run says it was
    // would turn a signed fact into an editable one.
    expect(rejoined.body.labels).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
  });

  // "Each agent becomes an ADP session."
  it("attaches one session per agent, inheriting the run's intent", async () => {
    coordinatorSession = await startSession("squad-coordinator");
    backendSession = await startSession("claude-code");
    testerSession = await startSession("claude-code");

    const run = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}`);
    expect(run.status).toBe(200);
    expect(run.body.sessions).toHaveLength(3);
    // The run states the intent once; sessions inherit it rather than each
    // caller having to repeat it and risk disagreeing.
    const detail = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${backendSession}`);
    expect(detail.body.intent_id).toBe(intentId);
    expect(detail.body.run_id).toBe(runId);
  });

  it("rejects a session claiming an intent that contradicts its run", async () => {
    const otherIssue = await api(`/api/v3/repos/${owner}/${repoName}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: "unrelated", body: "" }),
    });
    const res = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code", run_id: runId, intent_id: otherIssue.body.intent_id }),
    });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/does not match run/);
  });

  // "Every message, model call, tool execution, handoff, commit, and test
  // result is durably appended." All six kinds, across three sessions, with the
  // handoff carrying a real edge between two of them.
  it("appends all six event kinds across the run's sessions", async () => {
    const coordinator = await append(coordinatorSession, [
      {
        kind: "message",
        type: "assignment",
        payload: { role: "user", text: "Add a greeting module with tests" },
        occurred_at: "2026-08-04T10:00:00.000Z",
      },
      {
        kind: "handoff",
        type: "coordinator:routing",
        payload: { strategy: "multi", reason: "implementation then verification" },
        related_session_id: backendSession,
        occurred_at: "2026-08-04T10:00:01.000Z",
      },
      {
        kind: "handoff",
        type: "coordinator:routing",
        payload: { strategy: "multi", reason: "verification" },
        related_session_id: testerSession,
        occurred_at: "2026-08-04T10:00:02.000Z",
      },
    ]);
    expect(coordinator.status).toBe(201);
    expect(coordinator.body.appended).toBe(3);

    const backend = await append(backendSession, [
      {
        kind: "message",
        type: "system",
        payload: { role: "system", text: "You are the backend agent" },
        occurred_at: "2026-08-04T10:00:03.000Z",
      },
      {
        kind: "model_call",
        type: "completion",
        payload: { stop_reason: "tool_use" },
        model: "claude-opus-5",
        tokens_in: 1200,
        tokens_out: 300,
        cost_micro_usd: 9000,
        duration_ms: 2400,
        status: "success",
        occurred_at: "2026-08-04T10:00:04.000Z",
      },
      {
        kind: "tool_call",
        type: "Write",
        payload: { path: "greeting.js" },
        status: "success",
        duration_ms: 12,
        occurred_at: "2026-08-04T10:00:05.000Z",
      },
      {
        kind: "tool_call",
        type: "Bash",
        payload: { command: "node -e 'require(\"./greeting\")'" },
        status: "failure",
        duration_ms: 340,
        occurred_at: "2026-08-04T10:00:06.000Z",
      },
    ]);
    expect(backend.status).toBe(201);

    // The commit event names a sha this repository actually has, produced by a
    // real push — the whole point of `git_sha` as a typed column is that the
    // trajectory joins to the change record without anyone parsing a payload.
    await writeFile(path.join(workdir, "greeting.js"), "module.exports = () => 'hello';\n");
    await execFileAsync("git", ["add", "."], { cwd: workdir });
    await execFileAsync("git", ["commit", "-m", "feat: greeting module"], { cwd: workdir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: workdir });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workdir });
    finalSha = stdout.trim();

    const committed = await append(backendSession, [
      {
        kind: "commit",
        type: "push",
        payload: { message: "feat: greeting module", branch: "main" },
        git_sha: finalSha,
        status: "success",
        occurred_at: "2026-08-04T10:00:07.000Z",
      },
    ]);
    expect(committed.status).toBe(201);

    const tester = await append(testerSession, [
      {
        kind: "model_call",
        type: "completion",
        payload: { stop_reason: "end_turn" },
        model: "claude-sonnet-5",
        tokens_in: 800,
        tokens_out: 150,
        cost_micro_usd: 1200,
        duration_ms: 1100,
        status: "success",
        occurred_at: "2026-08-04T10:00:08.000Z",
      },
      {
        kind: "test_result",
        type: "vitest",
        payload: { passed: 4, failed: 0, suite: "greeting" },
        status: "success",
        duration_ms: 5300,
        git_sha: finalSha,
        occurred_at: "2026-08-04T10:00:09.000Z",
      },
    ]);
    expect(tester.status).toBe(201);

    const trajectory = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/trajectory?limit=100`);
    expect(trajectory.status).toBe(200);
    expect(trajectory.body.total).toBe(10);
    // Merged across sessions in the order things actually happened, not grouped
    // by whichever session was queried first.
    const times = trajectory.body.events.map((e: { occurred_at: string }) => e.occurred_at);
    expect([...times].sort()).toEqual(times);
    const kinds = new Set(trajectory.body.events.map((e: { kind: string }) => e.kind));
    expect(kinds).toEqual(new Set(["message", "model_call", "tool_call", "handoff", "commit", "test_result"]));
  });

  it("is idempotent under a retried batch, which is what a batching emitter does", async () => {
    const events = [
      {
        kind: "message",
        type: "assistant",
        payload: { text: "done" },
        client_event_id: "squad-evt-9001",
        occurred_at: "2026-08-04T10:00:10.000Z",
      },
    ];
    const first = await append(backendSession, events);
    expect(first.status).toBe(201);
    expect(first.body.appended).toBe(1);
    const head = first.body.head;

    const retry = await append(backendSession, events);
    expect(retry.status).toBe(201);
    expect(retry.body.appended).toBe(0);
    // Reported rather than silently absorbed — an emitter re-sending a landed
    // batch has a bug, and silence would let it stay one.
    expect(retry.body.duplicates).toEqual(["squad-evt-9001"]);
    expect(retry.body.head).toBe(head);
  });

  it("rejects a handoff naming a session outside the repository", async () => {
    const res = await append(coordinatorSession, [
      {
        kind: "handoff",
        type: "coordinator:routing",
        payload: {},
        related_session_id: "00000000-0000-0000-0000-000000000000",
      },
    ]);
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/related_session_id not found/);
  });

  // "A checkpoint attests to what the agent did, not only where it got to."
  it("binds the trajectory chain head into the signed checkpoint", async () => {
    const checkpoint = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${backendSession}/checkpoints`, {
      method: "POST",
      body: JSON.stringify({ git_sha: finalSha, state: { cursor: 42 } }),
    });
    expect(checkpoint.status).toBe(201);

    const envelope = checkpoint.body.envelope as DsseEnvelope;
    expect(verifyEnvelope(signer, envelope)).toBe(true);
    const predicate = decodeStatement(envelope).predicate as { trajectoryHead: string; eventCount: number };

    const events = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${backendSession}/events`);
    const last = events.body.events[events.body.events.length - 1];
    expect(predicate.trajectoryHead).toBe(last.hash);
    expect(predicate.eventCount).toBe(last.seq);
  });

  it("computes the stats eval-based optimization reads a run off", async () => {
    const stats = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/stats`);
    expect(stats.status).toBe(200);
    expect(stats.body.sessions).toBe(3);
    expect(stats.body.tokensIn).toBe(2000);
    expect(stats.body.tokensOut).toBe(450);
    expect(stats.body.costMicroUsd).toBe(10200);

    const tools = Object.fromEntries(stats.body.tools.map((t: { name: string; count: number }) => [t.name, t.count]));
    expect(tools).toEqual({ Write: 1, Bash: 1 });
    const bash = stats.body.tools.find((t: { name: string }) => t.name === "Bash");
    expect(bash.failures).toBe(1);

    const models = stats.body.models.map((m: { model: string }) => m.model).sort();
    expect(models).toEqual(["claude-opus-5", "claude-sonnet-5"]);

    // The handoff graph, read off typed edges rather than reconstructed by
    // parsing payloads.
    expect(stats.body.handoffs).toHaveLength(2);
    expect(stats.body.handoffs.map((h: { to: string }) => h.to).sort()).toEqual(
      [backendSession, testerSession].sort(),
    );
    expect(stats.body.commits).toEqual([finalSha]);
  });

  // "The run closes against a final Git SHA."
  it("closes the run against the commit it produced and signs the binding", async () => {
    const closed = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/close`, {
      method: "POST",
      body: JSON.stringify({ final_git_sha: finalSha }),
    });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe("closed");
    expect(closed.body.final_git_sha).toBe(finalSha);
    expect(closed.body.closed_sessions).toHaveLength(3);

    const envelope = closed.body.envelope as DsseEnvelope;
    expect(verifyEnvelope(signer, envelope)).toBe(true);
    const statement = decodeStatement(envelope);
    expect(statement.subject[0]!.digest.sha1).toBe(finalSha);
    const predicate = statement.predicate as {
      trajectoryDigest: string;
      labels: Record<string, string>;
      sessions: { id: string; eventCount: number; chainHead: string }[];
    };
    // The labels ride inside the signed predicate, which is what makes "this
    // result came from claude-sonnet-5" attested rather than annotated — the
    // difference between an A/B test and a table someone can edit afterwards.
    expect(predicate.labels).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(predicate.trajectoryDigest).toBe(closed.body.trajectory_digest);
    expect(predicate.sessions).toHaveLength(3);
    expect(predicate.sessions.reduce((n, s) => n + s.eventCount, 0)).toBe(11);
  });

  it("refuses to close against a commit the repository does not have", async () => {
    const other = await api(`/api/adp/repos/${owner}/${repoName}/runs`, {
      method: "POST",
      body: JSON.stringify({ intent_id: intentId, orchestrator: "squad", external_ref: "issue:ghost" }),
    });
    const res = await api(`/api/adp/repos/${owner}/${repoName}/runs/${other.body.id}/close`, {
      method: "POST",
      body: JSON.stringify({ final_git_sha: "b".repeat(40) }),
    });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/could not be resolved/);
  });

  // Closing signs each session's chain head. If a session could keep appending
  // afterwards, the attestation would describe a trajectory that no longer
  // exists — verification failing for an honest reason is worse than absent.
  it("stops the trajectory growing after the attestation is signed", async () => {
    const res = await append(backendSession, [{ kind: "message", type: "assistant", payload: { text: "late" } }]);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/closed session/);

    const rejoin = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code", run_id: runId }),
    });
    expect(rejoin.status).toBe(409);
  });

  it("is idempotent on re-close, and refuses a different sha", async () => {
    const again = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/close`, {
      method: "POST",
      body: JSON.stringify({ final_git_sha: finalSha }),
    });
    expect(again.status).toBe(200);
    expect(again.body.already_closed).toBe(true);

    const conflicting = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/close`, {
      method: "POST",
      body: JSON.stringify({ final_git_sha: "c".repeat(40) }),
    });
    expect(conflicting.status).toBe(409);
  });

  // "A deterministic eval result is attached to that run and reported as gate
  // evidence." Both halves are checked: the run binding, and that the result
  // arrives through the ordinary gate path rather than a private one.
  it("records a deterministic eval and reports it as gate evidence", async () => {
    const spec = { suite: "greeting-behavior", cases: 12, seed: 7 };
    const recorded = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/evals`, {
      method: "POST",
      body: JSON.stringify({ name: "behavior", passed: true, score: 0.92, spec, gate_name: "score" }),
    });
    expect(recorded.status).toBe(201);
    expect(recorded.body.git_sha).toBe(finalSha);
    expect(recorded.body.score).toBe(0.92);

    const envelope = recorded.body.gate.envelope as DsseEnvelope;
    expect(verifyEnvelope(signer, envelope)).toBe(true);
    const predicate = decodeStatement(envelope).predicate as {
      score: number;
      specDigest: string;
      runId: string;
      trajectoryDigest: string;
    };
    // The binding brief v5 calls "the half nobody has built": this score, that
    // commit, that trajectory, that eval definition — in one signed statement.
    expect(predicate.runId).toBe(runId);
    expect(predicate.score).toBe(0.92);
    const run = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}`);
    expect(predicate.trajectoryDigest).toBe(run.body.trajectory_digest);

    // Same eval definition, same digest — what makes "deterministic" checkable
    // rather than an adjective. Key order differs deliberately.
    const rerun = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/evals`, {
      method: "POST",
      body: JSON.stringify({
        name: "behavior",
        passed: true,
        score: 0.92,
        spec: { seed: 7, cases: 12, suite: "greeting-behavior" },
      }),
    });
    expect(rerun.body.spec_digest).toBe(recorded.body.spec_digest);

    // Reported as gate evidence: readable through the ordinary gate endpoint...
    const gates = await api(`/api/v3/repos/${owner}/${repoName}/commits/${finalSha}/gates`);
    expect(gates.status).toBe(200);
    const names = (gates.body as unknown as { name: string }[]).map((g) => g.name);
    expect(names).toContain("score");
    // ...and through the evidence bundle, with no eval-specific path anywhere.
    const evidence = await api(`/api/adp/repos/${owner}/${repoName}/evidence/${finalSha}`);
    expect(evidence.body.gates.map((g: { name: string }) => g.name)).toContain("score");
  });

  it("refuses an eval for a run that never closed and names no commit", async () => {
    const open = await api(`/api/adp/repos/${owner}/${repoName}/runs`, {
      method: "POST",
      body: JSON.stringify({ intent_id: intentId, orchestrator: "squad", external_ref: "issue:unclosed" }),
    });
    const res = await api(`/api/adp/repos/${owner}/${repoName}/runs/${open.body.id}/evals`, {
      method: "POST",
      body: JSON.stringify({ name: "behavior", passed: true }),
    });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/close the run first/);
  });

  // Tamper-evidence that nobody can check is decoration. This edits a stored
  // row behind the API's back — the only way the guarantee is worth stating.
  it("detects a tampered event and names where the chain broke", async () => {
    const before = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/verify`);
    expect(before.status).toBe(200);
    expect(before.body.ok).toBe(true);
    expect(before.body.chains_ok).toBe(true);
    expect(before.body.envelope_verified).toBe(true);
    expect(before.body.trajectory_digest_matches).toBe(true);

    // Rewrite a projection column, not the payload: if the hash covered only
    // `payload`, this edit would pass and the numbers an optimizer reads could
    // be rewritten at will.
    await db
      .update(sessionEvents)
      .set({ tokensOut: 999_999 })
      .where(and(eq(sessionEvents.sessionId, backendSession), eq(sessionEvents.kind, "model_call")));

    const after = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/verify`);
    expect(after.body.ok).toBe(false);
    expect(after.body.chains_ok).toBe(false);
    const broken = after.body.sessions.find((s: { session_id: string }) => s.session_id === backendSession);
    expect(broken.ok).toBe(false);
    expect(broken.broke_at_seq).toBe(2);
    expect(broken.reason).toMatch(/does not match its recorded hash/);
    // The other sessions are unaffected — the failure is localized, not a
    // blanket "something is wrong somewhere".
    const intact = after.body.sessions.find((s: { session_id: string }) => s.session_id === testerSession);
    expect(intact.ok).toBe(true);

    // Put it back, so the comparison test below reads an honest run.
    await db
      .update(sessionEvents)
      .set({ tokensOut: 300 })
      .where(and(eq(sessionEvents.sessionId, backendSession), eq(sessionEvents.kind, "model_call")));
    const restored = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/verify`);
    expect(restored.body.ok).toBe(true);
  });

  // The point of recording trajectories: N attempts at one assignment, each
  // pairing an attested outcome with what it cost to produce.
  it("compares runs against one intent, ranked by attested score", async () => {
    const second = await api(`/api/adp/repos/${owner}/${repoName}/runs`, {
      method: "POST",
      body: JSON.stringify({
        intent_id: intentId,
        orchestrator: "squad",
        external_ref: "issue:1-attempt-2",
        labels: { provider: "gemini", model: "gemini-flash-latest" },
      }),
    });
    const secondRun = second.body.id as string;
    comparedRuns = { first: runId, second: secondRun };
    const session = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code", run_id: secondRun }),
    });
    await append(session.body.id, [
      {
        kind: "model_call",
        type: "completion",
        payload: {},
        model: "claude-opus-5",
        tokens_in: 9000,
        tokens_out: 4000,
        cost_micro_usd: 88000,
        status: "success",
      },
      { kind: "tool_call", type: "Bash", payload: {}, status: "failure" },
      { kind: "tool_call", type: "Bash", payload: {}, status: "failure" },
    ]);
    await api(`/api/adp/repos/${owner}/${repoName}/runs/${secondRun}/close`, {
      method: "POST",
      body: JSON.stringify({ final_git_sha: finalSha }),
    });
    await api(`/api/adp/repos/${owner}/${repoName}/runs/${secondRun}/evals`, {
      method: "POST",
      body: JSON.stringify({ name: "behavior", passed: false, score: 0.41, spec: { suite: "greeting-behavior" } }),
    });

    const compare = await api(
      `/api/adp/repos/${owner}/${repoName}/runs/compare?intent_id=${intentId}&eval=behavior`,
    );
    expect(compare.status).toBe(200);
    const scored = compare.body.runs.filter((r: { eval: unknown }) => r.eval !== null);
    expect(scored[0].runId).toBe(runId);
    expect(scored[0].eval.score).toBe(0.92);
    expect(scored[1].runId).toBe(secondRun);
    expect(scored[1].eval.score).toBe(0.41);

    // Each row pairs the outcome with the cost of reaching it — the winning run
    // was also the cheaper one here, which is the kind of thing this table
    // exists to make visible.
    expect(scored[0].costMicroUsd).toBe(10200);
    expect(scored[1].costMicroUsd).toBe(88000);
    expect(scored[1].toolFailures).toBe(2);

    // An unscored run sorts last rather than as if it scored zero: unmeasured is
    // not the same as bad, and pretending otherwise invents evidence.
    const unscored = compare.body.runs.filter((r: { eval: unknown }) => r.eval === null);
    expect(unscored.length).toBeGreaterThan(0);
    const lastScoredIndex = compare.body.runs.findIndex((r: { runId: string }) => r.runId === secondRun);
    const firstUnscoredIndex = compare.body.runs.findIndex((r: { eval: unknown }) => r.eval === null);
    expect(firstUnscoredIndex).toBeGreaterThan(lastScoredIndex);
  });

  // A run scored on several axes has several results. Collapsing them to one
  // made the surviving score depend on which POST landed second, which is not a
  // property of the work — and a blended average would have hidden the case
  // this whole comparison exists to surface: two runs tied on one axis and
  // opposite on another.
  it("carries every named eval, and the labels the run was opened with", async () => {
    const { first, second } = comparedRuns;

    // A second axis on each run, and one of them scored twice — a regrade after
    // a fixed rubric, which must supersede rather than accumulate.
    await api(`/api/adp/repos/${owner}/${repoName}/runs/${first}/evals`, {
      method: "POST",
      body: JSON.stringify({ name: "self-tests", passed: false, score: 0, spec: { suite: "repo-self-tests" } }),
    });
    await api(`/api/adp/repos/${owner}/${repoName}/runs/${second}/evals`, {
      method: "POST",
      body: JSON.stringify({ name: "self-tests", passed: false, score: 0.5, spec: { suite: "repo-self-tests" } }),
    });
    await api(`/api/adp/repos/${owner}/${repoName}/runs/${second}/evals`, {
      method: "POST",
      body: JSON.stringify({ name: "self-tests", passed: true, score: 1, spec: { suite: "repo-self-tests" } }),
    });

    const compare = await api(`/api/adp/repos/${owner}/${repoName}/runs/compare?intent_id=${intentId}`);
    expect(compare.status).toBe(200);
    const rowFor = (id: string) =>
      compare.body.runs.find((r: { runId: string }) => r.runId === id) as {
        labels: Record<string, string>;
        eval: { name: string; score: number } | null;
        evals: { name: string; score: number | null; specDigest: string }[];
      };

    // One entry per name, not per POST.
    const firstRow = rowFor(first);
    expect(firstRow.evals.map((e) => e.name)).toEqual(["behavior", "self-tests"]);
    expect(firstRow.evals.find((e) => e.name === "behavior")?.score).toBe(0.92);
    expect(firstRow.evals.find((e) => e.name === "self-tests")?.score).toBe(0);

    // The duplicate resolves to the later one, matching how gate results
    // resolve everywhere else: a rerun supersedes, history is kept.
    const secondRow = rowFor(second);
    expect(secondRow.evals.filter((e) => e.name === "self-tests")).toHaveLength(1);
    expect(secondRow.evals.find((e) => e.name === "self-tests")?.score).toBe(1);

    // The pre-existing field keeps its old meaning exactly — latest overall,
    // whatever its name. Redefining it would have been a major bump for every
    // consumer already reading it.
    expect(firstRow.eval?.name).toBe("self-tests");
    expect(secondRow.eval?.name).toBe("self-tests");
    expect(secondRow.eval?.score).toBe(1);

    // And the labels each run was opened with, so ranking by vendor never has
    // to parse `external_ref`.
    expect(firstRow.labels).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(secondRow.labels).toEqual({ provider: "gemini", model: "gemini-flash-latest" });

    // The load-bearing one: a new field in the signed predicate must not have
    // broken the binding it sits next to.
    for (const id of [first, second]) {
      const verified = await api(`/api/adp/repos/${owner}/${repoName}/runs/${id}/verify`);
      expect(verified.body.ok).toBe(true);
      expect(verified.body.envelope_verified).toBe(true);
      expect(verified.body.trajectory_digest_matches).toBe(true);
    }
  });

  // Recorder completeness. `client_event_id` makes a retry harmless, but an
  // event that never arrived has no id to deduplicate — so it cannot prove
  // nothing was dropped. The emitter's own contiguous counter can, and these
  // tests take the criterion literally: the emitter skips a batch.
  it("rejects a batch that skips the emitter's own numbering, and says where to replay from", async () => {
    const opened = await api(`/api/adp/repos/${owner}/${repoName}/runs`, {
      method: "POST",
      body: JSON.stringify({ intent_id: intentId, orchestrator: "squad", external_ref: "issue:emitter" }),
    });
    emitterRun = opened.body.id;
    const session = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code", run_id: emitterRun }),
    });
    emitterSession = session.body.id;

    async function emit(events: unknown[]) {
      return api(`/api/adp/repos/${owner}/${repoName}/sessions/${emitterSession}/events`, {
        method: "POST",
        body: JSON.stringify({ producer_id: "squad-sdk@0.11.0", events }),
      });
    }
    const message = (n: number) => ({
      kind: "message",
      type: "assistant",
      payload: { text: `step ${n}` },
      producer_seq: n,
      client_event_id: `emit-${n}`,
    });

    const first = await emit([message(1), message(2)]);
    expect(first.status).toBe(201);
    // The mark the emitter trims its spool against.
    expect(first.body.accepted_through).toBe(2);

    // The batch carrying 3 and 4 is lost in flight; the emitter carries on with
    // 5 and 6. This is the exact failure `client_event_id` cannot see.
    const skipped = await emit([message(5), message(6)]);
    expect(skipped.status).toBe(409);
    expect(skipped.body.expected_next_seq).toBe(3);

    // Rejected whole, not partially absorbed — a half-landed batch would leave
    // the emitter unable to say what ADP holds.
    const afterReject = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${emitterSession}/events`);
    expect(afterReject.body.events).toHaveLength(2);

    const replayed = await emit([message(3), message(4)]);
    expect(replayed.status).toBe(201);
    expect(replayed.body.accepted_through).toBe(4);
    expect(replayed.body.events.map((e: { producer_seq: number }) => e.producer_seq)).toEqual([3, 4]);

    // A spool replaying more than it needed to is the ordinary shape of crash
    // recovery: the already-landed events dedup away and the rest chain on.
    const overlapping = await emit([message(4), message(5)]);
    expect(overlapping.status).toBe(201);
    expect(overlapping.body.duplicates).toEqual(["emit-4"]);
    expect(overlapping.body.accepted_through).toBe(5);
  });

  it("refuses a half-counted batch, which would leave the emitter a hole it cannot explain", async () => {
    const res = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${emitterSession}/events`, {
      method: "POST",
      body: JSON.stringify({
        events: [
          { kind: "message", type: "assistant", payload: {}, producer_seq: 6 },
          { kind: "message", type: "assistant", payload: {} },
        ],
      }),
    });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/every event in a batch or on none/);
  });

  // The sharp version of the claim: a chain can verify perfectly and still be
  // missing events, because the chain only vouches for what ADP was given. So
  // the gap is forced with a correctly-chained row — chains_ok stays true, and
  // `ok` must go false anyway or "recorder completeness" means nothing.
  it("names a gap in the emitter's numbering even when the chain itself verifies", async () => {
    const [tail] = await db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, emitterSession))
      .orderBy(sql`${sessionEvents.seq} desc`)
      .limit(1);

    const row = {
      sessionId: emitterSession,
      seq: tail!.seq + 1,
      kind: "message" as const,
      type: "assistant",
      payload: { text: "step 7" } as object,
      status: null,
      model: null,
      tokensIn: null,
      tokensOut: null,
      costMicroUsd: null,
      durationMs: null,
      gitSha: null,
      relatedSessionId: null,
      // 6 never arrived.
      producerSeq: 7,
      producerId: "squad-sdk@0.11.0",
      occurredAt: new Date("2026-08-04T11:00:00.000Z"),
    };
    await db.insert(sessionEvents).values({
      ...row,
      clientEventId: "emit-7",
      prevHash: tail!.hash,
      hash: eventHash(emitterSession, tail!.hash, row),
    });

    const verify = await api(`/api/adp/repos/${owner}/${repoName}/runs/${emitterRun}/verify`);
    expect(verify.status).toBe(200);
    // The chain is intact: nothing was edited, something was never delivered.
    expect(verify.body.chains_ok).toBe(true);
    expect(verify.body.emitters_ok).toBe(false);
    expect(verify.body.ok).toBe(false);

    const entry = verify.body.sessions.find((s: { session_id: string }) => s.session_id === emitterSession);
    expect(entry.emitter_tracked).toBe(true);
    expect(entry.emitter_complete).toBe(false);
    expect(entry.emitter_first_gap).toBe(6);
  });

  // An emitter that never claimed to be counting has not failed to deliver.
  // Untracked and incomplete have to read differently or the field is noise.
  it("reports a session whose emitter does not count as untracked, not incomplete", async () => {
    const verify = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/verify`);
    const entry = verify.body.sessions.find((s: { session_id: string }) => s.session_id === backendSession);
    expect(entry.emitter_tracked).toBe(false);
    expect(entry.emitter_complete).toBe(true);
    expect(entry.emitter_first_gap).toBe(null);
    expect(verify.body.emitters_ok).toBe(true);
    expect(verify.body.ok).toBe(true);
  });

  // "A separately authorized deterministic eval." A score is only independent
  // evidence if the identity that reported it is not the identity that did the
  // work — so ADP has to say which of the two it was.
  it("distinguishes a self-reported eval from one a separate identity reported", async () => {
    const own = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/evals`);
    const self = own.body.evals.find((e: { name: string }) => e.name === "behavior");
    expect(self.reporter_principal).toBe(actorPrincipal);
    // Reported by the same identity that opened the run: a self-report.
    expect(self.separately_authorized).toBe(false);

    const reporterPrincipal = `eval-reporter-${Date.now()}`;
    const [reporter] = await db
      .insert(identities)
      .values({ kind: "agent", principal: reporterPrincipal })
      .returning();
    const reporterToken = await mintToken(db, reporter!.id, ["repo:read", "repo:write"]);
    await grantOwner(db, reporter!.id, owner);
    await grantOwner(db, reporter!.id, owner);

    const recorded = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/evals`, {
      method: "POST",
      headers: { Authorization: `Bearer ${reporterToken}` },
      body: JSON.stringify({
        name: "independent-behavior",
        passed: true,
        score: 0.88,
        spec: { suite: "greeting-behavior", cases: 12, seed: 7 },
      }),
    });
    expect(recorded.status).toBe(201);
    expect(recorded.body.reporter_principal).toBe(reporterPrincipal);
    expect(recorded.body.separately_authorized).toBe(true);

    // The same answer wherever a consumer reads it from — the run, the eval
    // list, and verify — rather than only on the response that created it.
    const run = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}`);
    const onRun = run.body.evals.find((e: { name: string }) => e.name === "independent-behavior");
    expect(onRun.separately_authorized).toBe(true);
    expect(onRun.reporter_principal).toBe(reporterPrincipal);

    const verify = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/verify`);
    const attested = verify.body.evals.find((e: { name: string }) => e.name === "independent-behavior");
    expect(attested.separately_authorized).toBe(true);
    expect(verify.body.evals.find((e: { name: string }) => e.name === "behavior").separately_authorized).toBe(false);

    // Still one evidence path: the independent score arrives as an ordinary
    // gate result, signed, exactly like the self-reported one.
    const envelope = recorded.body.gate.envelope as DsseEnvelope;
    expect(verifyEnvelope(signer, envelope)).toBe(true);
    expect((decodeStatement(envelope).predicate as { reporter: string }).reporter).toBe(reporterPrincipal);
  });

  it("records every step in the op log, so the run is walkable from history alone", async () => {
    const ops = await db
      .select({ verb: operations.verb })
      .from(operations)
      .where(sql`${operations.target} like ${`${owner}/${repoName}@run:${runId}%`}`);
    const verbs = ops.map((o) => o.verb);
    expect(verbs).toContain("run.open");
    expect(verbs).toContain("run.close");
    expect(verbs).toContain("eval.record");
  });
});
