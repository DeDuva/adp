import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { identities, operations, checkpoints as checkpointsTable, sessionEvents } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { findRepo } from "../src/core/repos-lookup.js";
import {
  MAX_BATCH_PAYLOAD_BYTES,
  MAX_CHECKPOINT_STATE_BYTES,
  MAX_EVENT_PAYLOAD_BYTES,
} from "../src/core/payload-limits.js";
import { canonicalJson } from "../src/core/canonical.js";
import { verifyChain } from "../src/core/trajectory.js";
import { verifyEnvelope, decodeStatement, type DsseEnvelope } from "../src/core/dsse.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { repoAccessCheck } from "../src/core/repos-lookup.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerIssueRoutes } from "../src/http-rest/issues.js";
import { registerWorkspaceRoutes } from "../src/http-rest/workspaces.js";
import { registerOperationRoutes } from "../src/http-rest/operations.js";
import { registerSessionRoutes } from "../src/http-rest/sessions.js";

const execFileAsync = promisify(execFile);
const SIGNING_KEY = "e2e-sessions-signing-key";
const PUBLIC_URL = "https://adp.example.com";

// M3 / D2:
// "Start a refactoring task in Claude Code; checkpoint via ADP mid-task; resume
// in OpenHands … One continuous signed history across both harnesses."
//
// What this proves is that the *protocol* is harness-neutral: `harness` is an
// opaque identifier ADP never branches on, so two different values exercise
// exactly the path two real harnesses would. Vendoring two real harnesses is
// not M3 scope and this test does not pretend otherwise.
describe.skipIf(skipWithoutDb)("M3: cross-harness checkpoint and resume (D2)", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let gitBackend: GitBackend;
  let signer: Signer;
  let port: number;
  let token: string;
  let mainSha: string;
  const owner = `sessions-owner-${Date.now()}`;
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

  // #148 and #199 both hang off `adp.yaml`, and both need a repo whose policy
  // differs from the default. Seeding one is a clone, a commit and a push over
  // the real git wire — which was written inline when only one test needed it.
  async function seedRepoWithPolicy(name: string, adpYaml: string): Promise<void> {
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name }) });
    const seed = await mkdtemp(path.join(tmpdir(), `adp-e2e-sessions-${name}-`));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${name}.git`;
    await execFileAsync("git", ["clone", cloneUrl, seed]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: seed });
    await execFileAsync("git", ["config", "user.email", "seed@example.com"], { cwd: seed });
    await execFileAsync("git", ["config", "user.name", "Seed"], { cwd: seed });
    await writeFile(path.join(seed, "adp.yaml"), adpYaml);
    await execFileAsync("git", ["add", "."], { cwd: seed });
    await execFileAsync("git", ["commit", "-m", `${name} trajectory policy`], { cwd: seed });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: seed });
    await rm(seed, { recursive: true, force: true });
  }

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-sessions-git-"));
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
    registerWorkspaceRoutes(app, db, gitBackend);
    registerOperationRoutes(app, db, gitBackend);
    registerSessionRoutes(app, db, gitBackend, signer, PUBLIC_URL);
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;
    gitBackend.setInternalUrl(`http://127.0.0.1:${port}`);

    const [identity] = await db
      .insert(identities)
      .values({ kind: "agent", principal: `sessions-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);

    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: repoName }) });

    const seed = await mkdtemp(path.join(tmpdir(), "adp-e2e-sessions-seed-"));
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

  // A commit on a workspace branch, standing in for whatever an agent did.
  async function commitOn(branch: string, parentSha: string, message: string) {
    const tree = await gitBackend.statPath(owner, repoName, parentSha, "");
    const sha = await gitBackend.createCommit(owner, repoName, tree!.sha, [parentSha], message, {
      name: "agent",
      email: "agent@adp.local",
    });
    await gitBackend.fastForwardRef(owner, repoName, branch, parentSha, sha);
    return sha;
  }

  it("a session checkpointed in one harness resumes in another as one signed, linked history", async () => {
    const issue = await api(`/api/v3/repos/${owner}/${repoName}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: "refactor the widget" }),
    });
    const intentId = issue.body.intent_id as string;

    const ws = await api(`/api/adp/repos/${owner}/${repoName}/workspaces`, {
      method: "POST",
      body: JSON.stringify({ base_ref: "main" }),
    });
    const branchA = ws.body.branch as string;

    // --- harness A ---
    const started = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code", intent_id: intentId, workspace_id: ws.body.id }),
    });
    expect(started.status).toBe(201);
    expect(started.body.harness).toBe("claude-code");
    const sessionA = started.body.id as string;

    const workSha = await commitOn(branchA, mainSha, "half the refactor");

    const harnessState = { plan: ["extract helper", "update callers"], step: 1, scratch: "midway" };
    const checkpoint = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionA}/checkpoints`, {
      method: "POST",
      body: JSON.stringify({ git_sha: workSha, state: harnessState }),
    });
    expect(checkpoint.status).toBe(201);
    expect(checkpoint.body.seq).toBe(1);
    const checkpointId = checkpoint.body.id as string;

    // The checkpoint is real signed evidence, not a scratch row: the envelope
    // verifies, and it binds the commit *and* a digest of the opaque state.
    const envelope = checkpoint.body.envelope as DsseEnvelope;
    expect(verifyEnvelope(signer, envelope)).toBe(true);
    const statement = decodeStatement(envelope);
    expect(statement.subject[0]!.digest.sha1).toBe(workSha);
    expect((statement.predicate as { sessionId: string }).sessionId).toBe(sessionA);

    // --- harness B ---
    const resumed = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionA}/resume`, {
      method: "POST",
      body: JSON.stringify({ harness: "openhands" }),
    });
    expect(resumed.status).toBe(201);
    expect(resumed.body.harness).toBe("openhands");
    expect(resumed.body.resumed_from_session_id).toBe(sessionA);
    const sessionB = resumed.body.id as string;
    const branchB = (resumed.body.workspace as { branch: string }).branch;

    // The resumed workspace starts at exactly the checkpointed commit — that is
    // what "resume" has to mean for the history to be continuous.
    expect(await gitBackend.resolveRef(owner, repoName, branchB)).toBe(workSha);

    // Harness B finishes the work.
    const finalSha = await commitOn(branchB, workSha, "the other half");
    const checkpointB = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionB}/checkpoints`, {
      method: "POST",
      body: JSON.stringify({ git_sha: finalSha, state: { step: 2, done: true } }),
    });
    expect(checkpointB.status).toBe(201);
    // Sequence is per session, so harness B's first checkpoint is seq 1 again.
    expect(checkpointB.body.seq).toBe(1);

    // --- one continuous history, in one call ---
    const view = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionB}`);
    expect(view.status).toBe(200);
    const lineage = view.body.lineage as { id: string; harness: string; status: string }[];
    expect(lineage.map((s) => s.harness)).toEqual(["claude-code", "openhands"]);
    expect(lineage[0]!.id).toBe(sessionA);
    expect(lineage[0]!.status).toBe("resumed");
    expect(lineage[1]!.id).toBe(sessionB);

    // ...and in the op log, with the resume linked to the checkpoint it
    // resumed from. If reconstructing D2's chain took more than this, the
    // object model would be wrong.
    const repo = await findRepo(db, owner, repoName);
    const ops = await db.select().from(operations).where(eq(operations.repoId, repo!.id));
    const resumeOp = ops.find((o) => o.verb === "session.resume");
    expect(resumeOp).toBeTruthy();
    const checkpointOp = ops.find(
      (o) => o.verb === "session.checkpoint" && (o.after as { checkpointId?: string }).checkpointId === checkpointId,
    );
    expect(checkpointOp).toBeTruthy();
    expect(resumeOp!.parentOp).toBe(checkpointOp!.id);
    expect((resumeOp!.after as { resumedFromSessionId: string }).resumedFromSessionId).toBe(sessionA);
  }, 120_000);

  it("refuses to resume from a checkpoint whose state was tampered with", async () => {
    const ws = await api(`/api/adp/repos/${owner}/${repoName}/workspaces`, {
      method: "POST",
      body: JSON.stringify({ base_ref: "main" }),
    });
    const branch = ws.body.branch as string;

    const started = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code", workspace_id: ws.body.id }),
    });
    const sessionId = started.body.id as string;
    const sha = await commitOn(branch, mainSha, "work");

    const checkpoint = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionId}/checkpoints`, {
      method: "POST",
      body: JSON.stringify({ git_sha: sha, state: { secret: "original" } }),
    });
    expect(checkpoint.status).toBe(201);

    // Rewrite the state behind the envelope's back. The signature still
    // verifies — it covers the statement, not the row — which is precisely why
    // resume has to compare the state against its signed digest rather than
    // stopping at "the envelope checks out".
    await db
      .update(checkpointsTable)
      .set({ state: { secret: "tampered" } })
      .where(eq(checkpointsTable.id, checkpoint.body.id as string));

    const resumed = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionId}/resume`, {
      method: "POST",
      body: JSON.stringify({ harness: "openhands" }),
    });
    expect(resumed.status).toBe(422);
    expect(resumed.body.message).toContain("does not match its signed digest");
  }, 60_000);

  it("refuses to checkpoint a commit the repository does not have", async () => {
    const started = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code" }),
    });
    const sessionId = started.body.id as string;

    const res = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionId}/checkpoints`, {
      method: "POST",
      body: JSON.stringify({ git_sha: "b".repeat(40), state: {} }),
    });
    expect(res.status).toBe(422);
    expect(res.body.message).toContain("could not be resolved");

    // Nothing was written — a rejected checkpoint must not leave a row behind.
    const rows = await db.select().from(checkpointsTable).where(eq(checkpointsTable.sessionId, sessionId));
    expect(rows).toHaveLength(0);
  }, 60_000);

  // Two harnesses checkpointing one session at the same instant both used to
  // compute the same `seq` off max(seq); the unique index turned the loser into
  // an unhandled 23505, i.e. a 500 where the caller deserves either a
  // checkpoint or a typed error. The session row is now locked for the
  // allocation, so they serialize instead.
  it("allocates checkpoint sequences correctly under concurrent writes", async () => {
    const ws = await api(`/api/adp/repos/${owner}/${repoName}/workspaces`, {
      method: "POST",
      body: JSON.stringify({ base_ref: "main" }),
    });
    const branch = ws.body.branch as string;
    const started = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code", workspace_id: ws.body.id }),
    });
    const sessionId = started.body.id as string;

    const CONCURRENT = 8;
    let sha = mainSha;
    const shas: string[] = [];
    for (let i = 0; i < CONCURRENT; i++) {
      sha = await commitOn(branch, sha, `concurrent ${i}`);
      shas.push(sha);
    }

    const results = await Promise.all(
      shas.map((s) =>
        api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionId}/checkpoints`, {
          method: "POST",
          body: JSON.stringify({ git_sha: s, state: { s } }),
        }),
      ),
    );

    expect(results.every((r) => r.status === 201)).toBe(true);
    // 1..N with no gaps and no duplicates — the property the unique index
    // protects and the lock is what makes achievable rather than merely
    // enforced.
    const seqs = (results.map((r) => r.body.seq) as number[]).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: CONCURRENT }, (_unused, i) => i + 1));

    const rows = await db.select().from(checkpointsTable).where(eq(checkpointsTable.sessionId, sessionId));
    expect(rows).toHaveLength(CONCURRENT);
  }, 120_000);

  it("refuses to resume a session that has never checkpointed", async () => {
    const started = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code" }),
    });
    const res = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${started.body.id as string}/resume`, {
      method: "POST",
      body: JSON.stringify({ harness: "openhands" }),
    });
    expect(res.status).toBe(422);
    expect(res.body.message).toContain("no checkpoint");
  }, 60_000);

  it("keeps sessions scoped to their repository", async () => {
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: "other" }) });
    const started = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code" }),
    });
    const res = await api(`/api/adp/repos/${owner}/other/sessions/${started.body.id as string}`);
    expect(res.status).toBe(404);

    const [row] = await db
      .select()
      .from(checkpointsTable)
      .where(and(eq(checkpointsTable.sessionId, started.body.id as string)));
    expect(row).toBeUndefined();
  }, 60_000);

  it("accepts an event carrying only a kind, which is the minimum the contract declares legal", async () => {
    // The events endpoint declares `required: [kind]`, so this is a legal
    // request. `payload` was NOT NULL with no default and the insert sent an
    // explicit null, so it returned 500 — a recorder could take its own run
    // down by emitting something the spec permits. Reported by adp-replay
    // against contract 0.1.0; issue #63.
    //
    // Note a column default alone cannot fix this: Postgres defaults a column
    // that is *omitted*, not one handed an explicit null. The insert had to
    // stop sending null.
    const started = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code" }),
    });
    const sessionId = started.body.id as string;

    const res = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({ events: [{ kind: "message", client_event_id: "evt-no-payload" }] }),
    });
    expect(res.status).toBe(201);
    expect(res.body.appended).toBe(1);

    // Stored as `{}` rather than null, and the chain still verifies: the hash
    // commits to the same `{}` that was written.
    const rows = await db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.clientEventId, "evt-no-payload")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({});

    expect((await verifyChain(db, sessionId)).ok).toBe(true);
  }, 60_000);

  // #146: the ceilings, through the real route. The unit tests
  // (src/core/payload-limits.test.ts) cover the arithmetic; what this asserts
  // is the thing a producer actually meets — a typed 422 it can act on, and a
  // chain that was not touched on the way to it.
  it("refuses an oversized event and leaves the chain untouched", async () => {
    const started = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code" }),
    });
    const sessionId = started.body.id as string;

    // One legal event first, so there is a chain to leave alone.
    const seeded = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({ events: [{ kind: "message", client_event_id: "evt-before" }] }),
    });
    expect(seeded.status).toBe(201);

    const refused = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({
        events: [
          { kind: "message", client_event_id: "evt-fine" },
          { kind: "message", client_event_id: "evt-huge", payload: { blob: "x".repeat(MAX_EVENT_PAYLOAD_BYTES + 1) } },
        ],
      }),
    });
    expect(refused.status).toBe(422);
    const errors = refused.body.errors as { path: (string | number)[]; message: string; code: string }[];
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toEqual(["events", 1, "payload"]);
    expect(errors[0]!.message).toContain("evt-huge");
    expect(errors[0]!.message).toContain(String(MAX_EVENT_PAYLOAD_BYTES));

    // Refused as a *batch*: the legal event that shared the request is not
    // there either. appendEvents is all-or-nothing, and a refusal that let the
    // earlier events through would leave a chain the producer cannot reason
    // about.
    const stored = await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, sessionId));
    expect(stored.map((r) => r.clientEventId)).toEqual(["evt-before"]);
    expect((await verifyChain(db, sessionId)).ok).toBe(true);
  }, 60_000);

  // The transport used to answer first: Fastify's default 1 MiB body limit sat
  // *below* the batch ceiling, so an oversized batch got a bare 413 naming
  // nothing — the "discover the limit rather than respect it" failure the
  // ceiling exists to remove.
  it("answers an oversized batch with the typed refusal rather than a bare 413", async () => {
    const started = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code" }),
    });
    const sessionId = started.body.id as string;

    // Individually legal, collectively over: the case only the batch ceiling
    // catches, and the one that crosses Fastify's old limit on the way.
    const each = MAX_EVENT_PAYLOAD_BYTES - 1024;
    const count = Math.ceil(MAX_BATCH_PAYLOAD_BYTES / each) + 1;
    const res = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({
        events: Array.from({ length: count }, (_, i) => ({
          kind: "message",
          client_event_id: `evt-bulk-${i}`,
          payload: { blob: "x".repeat(each) },
        })),
      }),
    });

    expect(res.status).toBe(422);
    const errors = res.body.errors as { path: (string | number)[]; message: string }[];
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toEqual(["events"]);
    expect(errors[0]!.message).toContain(String(MAX_BATCH_PAYLOAD_BYTES));

    const stored = await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, sessionId));
    expect(stored).toHaveLength(0);
  }, 60_000);

  // #148: the Done-when, end to end. The unit tests cover the walker; this is
  // the thing that has to be true of the stored record.
  //
  // Against a repo that opted into `payloads: full` (#199), because that is
  // what this test is about: the redaction marker is visible *in the payload*,
  // and under the default the payload keeps no string content for it to be
  // visible in. The default's own behaviour on a secret is the test below.
  it("stores an event with its secret redacted, visibly, and the chain still verifies", async () => {
    const verbatimRepo = "verbatim";
    await seedRepoWithPolicy(verbatimRepo, "trajectory:\n  payloads: full\n");
    const started = await api(`/api/adp/repos/${owner}/${verbatimRepo}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code" }),
    });
    const sessionId = started.body.id as string;

    // The exact shape push protection cannot see: a file the agent *read* and
    // correctly declined to commit. It is in no diff, so nothing else in the
    // system would ever look at it.
    const awsKey = "AKIAABCDEFGHIJKLMNOP";
    const res = await api(`/api/adp/repos/${owner}/${verbatimRepo}/sessions/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({
        events: [
          {
            kind: "tool_call",
            type: "read_file",
            client_event_id: "evt-read-env",
            payload: { path: ".env", output: `AWS_ACCESS_KEY_ID=${awsKey}\nDEBUG=true` },
          },
        ],
      }),
    });
    expect(res.status).toBe(201);

    const [row] = await db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.clientEventId, "evt-read-env")));

    // The secret is not in the durable record, and what replaced it says so.
    const stored = JSON.stringify(row!.payload);
    expect(stored).not.toContain(awsKey);
    expect(stored).toContain("[redacted:aws-access-key-id]");
    // Surgical, not destructive: the rest of the event is still worth reading.
    expect((row!.payload as { path: string }).path).toBe(".env");
    expect(stored).toContain("DEBUG=true");

    // Recorded as a redaction, machine-readably, so a reader sees it happened
    // without having to spot it in the text.
    expect(row!.redactions).toEqual([{ path: "$.output", pattern: "aws-access-key-id" }]);

    // #199: null on the `full` path, which is what makes it the answer to "is
    // this payload verbatim" rather than a second name for the mode.
    expect(row!.payloadDigest).toBeNull();

    // And the chain commits to the redacted form — the redaction is part of
    // what verifies, not an edit applied to a record that already vouched for
    // the original.
    expect((await verifyChain(db, sessionId)).ok).toBe(true);
  }, 120_000);

  it("leaves a clean event's redactions null, so old rows keep hashing as they did", async () => {
    const started = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code" }),
    });
    const sessionId = started.body.id as string;
    await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({ events: [{ kind: "message", client_event_id: "evt-clean", payload: { text: "hello" } }] }),
    });

    const [row] = await db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.clientEventId, "evt-clean")));
    // Null, not []. `eventHash` keys off "is it set", so an empty array would
    // change what every ordinary event hashes to.
    expect(row!.redactions).toBeNull();
    expect((await verifyChain(db, sessionId)).ok).toBe(true);
  }, 60_000);

  // #199: the Done-when, end to end. The unit tests cover the projection; this
  // is what has to be true of the stored record when nobody configured
  // anything — which is the case that matters, because it is the one every
  // adopter gets.
  it("keeps a payload's shape and drops its content by default, and still verifies", async () => {
    const started = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code" }),
    });
    const sessionId = started.body.id as string;

    // Nothing a detector recognises, which is the surface this governs: source
    // no pattern covers, a customer name in a tool result, a prompt someone
    // typed.
    const contents = "function chargeCard(customer) { return stripe.charge(customer.ssn); }";
    const res = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({
        events: [
          {
            kind: "tool_call",
            type: "read_file",
            status: "success",
            duration_ms: 12,
            client_event_id: "evt-structure",
            payload: { path: "billing.js", output: contents, bytes: 69, truncated: false },
          },
        ],
      }),
    });
    expect(res.status).toBe(201);

    const [row] = await db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.clientEventId, "evt-structure")));

    // The content is not in the durable record — neither leaf of it.
    const stored = JSON.stringify(row!.payload);
    expect(stored).not.toContain("chargeCard");
    expect(stored).not.toContain("billing.js");

    // The shape is, and so is what each string cost. A reader sees a
    // `read_file` that returned 69 bytes from `$.output` and succeeded in
    // 12ms; the typed columns are untouched, which is where "what did the
    // agent do" is actually answered.
    expect(row!.payload).toEqual({
      path: `[adp:str bytes=${Buffer.byteLength("billing.js", "utf8")}]`,
      output: `[adp:str bytes=${Buffer.byteLength(contents, "utf8")}]`,
      bytes: 69,
      truncated: false,
    });
    expect(row!.type).toBe("read_file");
    expect(row!.status).toBe("success");
    expect(row!.durationMs).toBe(12);

    // The commitment: a producer holding its own copy can prove the record
    // corresponds to it, which is what makes "payload not retained" a
    // verification state rather than a hole.
    expect(row!.payloadDigest).toBe(
      createHash("sha256")
        .update(canonicalJson({ path: "billing.js", output: contents, bytes: 69, truncated: false }), "utf8")
        .digest("hex"),
    );

    // And it is covered by the chain, so it cannot be swapped afterwards for
    // one matching a payload that was never sent.
    expect((await verifyChain(db, sessionId)).ok).toBe(true);
    await db.update(sessionEvents).set({ payloadDigest: createHash("sha256").update("elsewhere").digest("hex") })
      .where(eq(sessionEvents.id, row!.id));
    expect((await verifyChain(db, sessionId)).ok).toBe(false);
    await db.update(sessionEvents).set({ payloadDigest: row!.payloadDigest }).where(eq(sessionEvents.id, row!.id));
  }, 60_000);

  it("serves the digest beside the payload, so a reader can tell projection from verbatim", async () => {
    const started = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code" }),
    });
    const sessionId = started.body.id as string;
    await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({ events: [{ kind: "message", type: "user", payload: { text: "ship it" } }] }),
    });

    const listed = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionId}/events`);
    const [event] = listed.body.events as { payload: unknown; payload_digest: string | null }[];
    expect(event!.payload).toEqual({ text: "[adp:str bytes=7]" });
    expect(event!.payload_digest).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
  }, 60_000);

  it("stores payloads as supplied when the repo opts into full, and claims no digest", async () => {
    // The asymmetry the default rests on: this is available to a repo that has
    // read what a trajectory holds and wants all of it. What is not available
    // is unsending what already arrived.
    const fullRepo = "full-payloads";
    await seedRepoWithPolicy(fullRepo, "trajectory:\n  payloads: full\n");
    const started = await api(`/api/adp/repos/${owner}/${fullRepo}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code" }),
    });
    const sessionId = started.body.id as string;

    await api(`/api/adp/repos/${owner}/${fullRepo}/sessions/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({
        events: [
          { kind: "message", type: "user", client_event_id: "evt-full", payload: { text: "keep every word" } },
        ],
      }),
    });

    const [row] = await db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.clientEventId, "evt-full")));
    expect(row!.payload).toEqual({ text: "keep every word" });
    // Null, not the digest of a payload that was retained: null is what says
    // "this is verbatim", and a `full` event has to go on hashing exactly as
    // it did before this column existed.
    expect(row!.payloadDigest).toBeNull();
    expect((await verifyChain(db, sessionId)).ok).toBe(true);
  }, 120_000);

  it("still records that the detector fired, on a payload it is no longer keeping", async () => {
    // The two mechanisms are not the same mechanism. Under the default the
    // secret's *content* was never going to be stored — but "a secret was in
    // this session" is a fact about the developer's environment that they need
    // to hear, and the `redactions` column is the only place left to hear it.
    const started = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code" }),
    });
    const sessionId = started.body.id as string;

    const awsKey = "AKIAABCDEFGHIJKLMNOP";
    await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({
        events: [
          {
            kind: "tool_call",
            type: "read_file",
            client_event_id: "evt-structured-secret",
            payload: { output: `AWS_ACCESS_KEY_ID=${awsKey}` },
          },
        ],
      }),
    });

    const [row] = await db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.clientEventId, "evt-structured-secret")));
    expect(JSON.stringify(row!.payload)).not.toContain(awsKey);
    expect(row!.redactions).toEqual([{ path: "$.output", pattern: "aws-access-key-id" }]);

    // The digest names what `full` would have stored — the redacted text — and
    // not the secret. A digest over the original would be a durable commitment
    // to exactly the value #148 exists to keep out of this table.
    expect(row!.payloadDigest).toBe(
      createHash("sha256")
        .update(canonicalJson({ output: "AWS_ACCESS_KEY_ID=[redacted:aws-access-key-id]" }), "utf8")
        .digest("hex"),
    );
    expect((await verifyChain(db, sessionId)).ok).toBe(true);
  }, 60_000);

  // The other half of the policy, and the reason `redact` is the default:
  // refusing loses the trajectory, and a lost trajectory teaches a user to
  // turn recording off. A deployment can opt into that trade; it does not get
  // it by accident.
  it("refuses the batch instead, when the repo's adp.yaml says to", async () => {
    const strictRepo = "strict";
    await seedRepoWithPolicy(strictRepo, "trajectory:\n  on_secret: refuse\n");

    const started = await api(`/api/adp/repos/${owner}/${strictRepo}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code" }),
    });
    const sessionId = started.body.id as string;

    const res = await api(`/api/adp/repos/${owner}/${strictRepo}/sessions/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({
        events: [
          { kind: "message", client_event_id: "evt-ok", payload: { text: "fine" } },
          { kind: "tool_call", client_event_id: "evt-leak", payload: { out: "AKIAABCDEFGHIJKLMNOP" } },
        ],
      }),
    });
    expect(res.status).toBe(422);
    const errors = res.body.errors as { path: (string | number)[]; message: string; code: string }[];
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("secret_detected");
    expect(errors[0]!.message).toContain("aws-access-key-id");
    // Located in the batch the producer sent, so it can find what to fix.
    expect(errors[0]!.path).toEqual(["events", 1, "out"]);

    // Refused as a batch: the clean event that shared the request is not
    // stored either, for the same reason #146's ceiling refuses as a batch.
    const stored = await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, sessionId));
    expect(stored).toHaveLength(0);
  }, 120_000);

  it("refuses an oversized checkpoint state, naming the limit", async () => {
    const started = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code" }),
    });
    const sessionId = started.body.id as string;
    // Any commit the repo actually has; the ceiling is about the state blob,
    // not the sha.
    const sha = mainSha;

    const res = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionId}/checkpoints`, {
      method: "POST",
      body: JSON.stringify({ git_sha: sha, state: { blob: "x".repeat(MAX_CHECKPOINT_STATE_BYTES + 1) } }),
    });
    expect(res.status).toBe(422);
    const errors = res.body.errors as { path: (string | number)[]; message: string }[];
    expect(errors[0]!.path).toEqual(["state"]);
    expect(errors[0]!.message).toContain(String(MAX_CHECKPOINT_STATE_BYTES));
  }, 60_000);
});
