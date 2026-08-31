import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type Db } from "../src/db/client.js";
import { identities } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { repoAccessCheck } from "../src/core/repos-lookup.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerIssueRoutes } from "../src/http-rest/issues.js";
import { registerSessionRoutes } from "../src/http-rest/sessions.js";
import { registerRunRoutes } from "../src/http-rest/runs.js";

const execFileAsync = promisify(execFile);
const SIGNING_KEY = "e2e-recorder-signing-key";
const PUBLIC_URL = "https://adp.example.com";

// The recorder as a *process*, not as an imported module.
//
// `recorder/` is a pure HTTP client with no `server/` import, and importing it
// from here would quietly make the dependency mutual — the exact coupling that
// rule exists to prevent, arriving through the test door. Spawning the CLI
// keeps the boundary real and has the better property besides: what is proven
// is the artifact someone actually runs, argument parsing and signal handling
// and all.
//
// The *built* artifact, run under plain `node`, rather than the sources under
// a loader. That is not fastidiousness: `npx tsx main.ts` puts one or two
// wrapper processes between the test and the recorder, and `child.kill()` then
// signals the wrapper. The live-transcript test below ends its recorder with
// SIGINT and asserts that the tail of the session still arrives, which is a
// test of nothing at all if the signal never reaches the process that handles
// it — as it did not, the first time this was written.
const RECORDER_ROOT = fileURLToPath(new URL("../../recorder", import.meta.url));
const RECORDER_MAIN = path.join(RECORDER_ROOT, "dist", "main.js");

// #149's exit criteria, against the real routes:
//
//   1. a session recorded end to end verifies, chains_ok and emitters_ok both true
//   2. killing the recorder mid-session and restarting produces a complete
//      chain with no duplicates
//   3. pointing it at an unreachable server, then restoring it, produces the same
//
// The fourth — that the agent cost is indistinguishable with the recorder
// attached — is a bench arm against a real model rather than an assertion, and
// is deliberately not faked here.
describe.skipIf(skipWithoutDb)("#149: adp-recorder against a live ADP", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  let spoolDir: string;
  let transcripts: string;
  const owner = `recorder-owner-${Date.now()}`;
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

  /** Run the recorder CLI, with the environment it reads its configuration from. */
  function recorder(args: string[], env: Record<string, string> = {}) {
    return execFileAsync(process.execPath, [RECORDER_MAIN, ...args], {
      cwd: RECORDER_ROOT,
      env: {
        ...process.env,
        ADP_SERVER_URL: `http://127.0.0.1:${port}`,
        ADP_TOKEN: token,
        ADP_RECORDER_SPOOL: spoolDir,
        ADP_RECORDER_ID: "e2e-recorder",
        ...env,
      },
    });
  }

  const init = () => JSON.stringify({ type: "system", subtype: "init", session_id: "harness-1", model: "test-model" });
  const say = (text: string) =>
    JSON.stringify({
      type: "assistant",
      message: { model: "test-model", content: [{ type: "text", text }], usage: { input_tokens: 3, output_tokens: 4 } },
    });
  const call = (id: string, command: string) =>
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
    });
  const result = (id: string, output: string) =>
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: output }] } });

  // The same session in the other harness's stream. Shapes taken from Codex's
  // own `codex-rs/exec/src/exec_events.rs`, which is the schema `codex exec
  // --json` serialises.
  const cxThread = () => JSON.stringify({ type: "thread.started", thread_id: "thread-1" });
  const cxSay = (text: string) =>
    JSON.stringify({ type: "item.completed", item: { id: `m-${text.length}`, type: "agent_message", text } });
  const cxRun = (id: string, command: string) =>
    JSON.stringify({ type: "item.started", item: { id, type: "command_execution", command, status: "in_progress" } });
  const cxRan = (id: string, output: string) =>
    JSON.stringify({
      type: "item.completed",
      item: { id, type: "command_execution", aggregated_output: output, exit_code: 0, status: "completed" },
    });
  const cxTurn = () =>
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 900, cached_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 0 },
    });

  beforeAll(async () => {
    // Built here rather than relied on: `make test-all` runs the server suite
    // before `make recorder`, so a dist from a previous run — or none at all —
    // is what this would otherwise find.
    await execFileAsync("npm", ["run", "build", "--prefix", RECORDER_ROOT], { cwd: RECORDER_ROOT });

    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-recorder-git-"));
    const gitBackend = new GitBackend(gitRoot);
    const signer = new Signer(SIGNING_KEY);

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, PUBLIC_URL);
    registerIssueRoutes(app, db);
    registerSessionRoutes(app, db, gitBackend, signer, PUBLIC_URL);
    registerRunRoutes(app, db, gitBackend, signer, PUBLIC_URL);
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;
    gitBackend.setInternalUrl(`http://127.0.0.1:${port}`);

    const [identity] = await db
      .insert(identities)
      .values({ kind: "agent", principal: `recorder-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: repoName }) });

    spoolDir = mkdtempSync(path.join(tmpdir(), "adp-e2e-recorder-spool-"));
    transcripts = mkdtempSync(path.join(tmpdir(), "adp-e2e-recorder-tx-"));
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
    await rm(spoolDir, { recursive: true, force: true });
    await rm(transcripts, { recursive: true, force: true });
  });

  /** What the spool directory holds, for asserting that a refusal left nothing behind. */
  function listSpooled(): string[] {
    return readdirSync(spoolDir).sort();
  }

  /** Open a run so the trajectory has something to verify against. */
  async function openRun(): Promise<{ runId: string; intentId: string }> {
    const issue = await api(`/api/v3/repos/${owner}/${repoName}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: "record me", body: "the trajectory is the point" }),
    });
    const intentId = issue.body.intent_id as string;
    const run = await api(`/api/adp/repos/${owner}/${repoName}/runs`, {
      method: "POST",
      body: JSON.stringify({ intent_id: intentId, orchestrator: "e2e" }),
    });
    return { runId: run.body.id as string, intentId };
  }

  it("records a finished transcript end to end, and the run verifies", async () => {
    // Exit criterion 1. `--from-start` is the finished-transcript case: the
    // file is complete before the recorder is pointed at it, which is exactly
    // how the bench's own trials leave a transcript behind today.
    const { runId } = await openRun();
    const file = path.join(transcripts, "complete.jsonl");
    writeFileSync(
      file,
      [
        init(),
        say("looking at the repo"),
        call("c1", "npm test"),
        result("c1", "4 passing"),
        say("done"),
        JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.0021, num_turns: 3, is_error: false }),
      ].join("\n") + "\n",
    );

    await recorder(["wrap", "--repo", `${owner}/${repoName}`, "--run", runId, "--", "cat", file]);

    const verify = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/verify`);
    expect(verify.status).toBe(200);
    // The two the issue names, and the single answer above them.
    expect(verify.body.chains_ok).toBe(true);
    expect(verify.body.emitters_ok).toBe(true);
    expect(verify.body.ok).toBe(true);

    const sessions = verify.body.sessions as { session_id: string; event_count: number }[];
    expect(sessions).toHaveLength(1);
    // init, message, tool_call, message, result — the tool call assembled from
    // its two lines rather than counted twice.
    expect(sessions[0]!.event_count).toBe(5);

    const events = await api(
      `/api/adp/repos/${owner}/${repoName}/sessions/${sessions[0]!.session_id}/events`,
    );
    const kinds = (events.body.events as { kind: string; type: string }[]).map((e) => `${e.kind}:${e.type}`);
    expect(kinds).toEqual([
      "custom:claude-code.init",
      "message:assistant",
      "tool_call:Bash",
      "message:assistant",
      "custom:claude-code.result",
    ]);
  }, 120_000);

  it("finishes a session a killed recorder left behind, with no duplicates", async () => {
    // Exit criterion 2. The kill is modelled by a recorder that spools without
    // delivering — ADP_SERVER_URL points nowhere — and then dies. `flush` is
    // the next run cleaning up after the last one, which is what makes
    // "survives its shell" true rather than aspirational.
    const { runId } = await openRun();
    const file = path.join(transcripts, "interrupted.jsonl");
    writeFileSync(file, [init(), say("first half"), call("c1", "ls")].join("\n") + "\n");

    // Port 9 is discard: reliably refused, never listening.
    await recorder(["wrap", "--repo", `${owner}/${repoName}`, "--run", runId, "--", "cat", file], {
      ADP_SERVER_URL: "http://127.0.0.1:9",
    }).catch(() => undefined);

    // Nothing reached ADP yet.
    const before = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/verify`);
    expect((before.body.sessions as unknown[]).length).toBe(0);

    // A later recorder finishes the job, twice — the second call proves the
    // replay is idempotent rather than merely working once.
    await recorder(["flush", "--repo", `${owner}/${repoName}`]);
    await recorder(["flush", "--repo", `${owner}/${repoName}`]);

    const verify = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/verify`);
    expect(verify.body.chains_ok).toBe(true);
    expect(verify.body.emitters_ok).toBe(true);
    const sessions = verify.body.sessions as { session_id: string; event_count: number }[];
    expect(sessions).toHaveLength(1);
    // init, message, and the tool call flushed at end-of-stream with no
    // result, plus the marker that says one call never resolved. Four, not
    // eight: flushing twice appended nothing the second time.
    expect(sessions[0]!.event_count).toBe(4);
  }, 120_000);

  it("records against an unreachable ADP, then delivers the whole session when it returns", async () => {
    // Exit criterion 3, including the hard half: ADP is down when the session
    // *starts*, so there is no session id to record against. The spool is
    // keyed by a local handle precisely so that recording can begin anyway.
    const { runId } = await openRun();
    const file = path.join(transcripts, "offline.jsonl");
    writeFileSync(file, [init(), say("one"), say("two"), say("three")].join("\n") + "\n");

    await recorder(["wrap", "--repo", `${owner}/${repoName}`, "--run", runId, "--", "cat", file], {
      ADP_SERVER_URL: "http://127.0.0.1:9",
    }).catch(() => undefined);

    await recorder(["flush"]);

    const verify = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/verify`);
    expect(verify.body.ok).toBe(true);
    expect(verify.body.chains_ok).toBe(true);
    expect(verify.body.emitters_ok).toBe(true);
    const sessions = verify.body.sessions as { session_id: string; event_count: number }[];
    expect(sessions[0]!.event_count).toBe(4);

    // The whole session, in order, numbered from 1 — which is what
    // emitters_ok is actually asserting.
    const events = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessions[0]!.session_id}/events`);
    const rows = events.body.events as { producer_seq: number; producer_id: string }[];
    expect(rows.map((e) => e.producer_seq)).toEqual([1, 2, 3, 4]);
    expect(rows[0]!.producer_id).toBe("e2e-recorder");
  }, 120_000);

  it("follows a transcript that is still being written", async () => {
    // What `tail` is for, and the reason it is the primary way to attach: the
    // harness needs no flag and no knowledge that anything is watching.
    const { runId } = await openRun();
    const file = path.join(transcripts, "live.jsonl");
    writeFileSync(file, "");

    const child = execFile(
      process.execPath,
      [RECORDER_MAIN, "tail", "--repo", `${owner}/${repoName}`, "--run", runId, "--file", file, "--from-start"],
      {
        cwd: RECORDER_ROOT,
        env: {
          ...process.env,
          ADP_SERVER_URL: `http://127.0.0.1:${port}`,
          ADP_TOKEN: token,
          ADP_RECORDER_SPOOL: spoolDir,
          ADP_RECORDER_FLUSH_INTERVAL_MS: "300",
        },
      },
    );

    // Written after the recorder is already following, which is the case a
    // finished-file test cannot cover.
    await new Promise((r) => setTimeout(r, 2500));
    appendFileSync(file, [init(), say("live one"), say("live two")].join("\n") + "\n");
    await new Promise((r) => setTimeout(r, 2500));

    // SIGINT is how a terminal ends a session, so it has to be the path that
    // drains rather than the path that loses the tail.
    child.kill("SIGINT");
    await new Promise((r) => setTimeout(r, 3000));
    await recorder(["flush"]).catch(() => undefined);

    const verify = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/verify`);
    expect(verify.body.chains_ok).toBe(true);
    expect(verify.body.emitters_ok).toBe(true);
    const sessions = verify.body.sessions as { event_count: number }[];
    expect(sessions[0]!.event_count).toBe(3);
  }, 180_000);

  // #150's exit criterion, sharing #149's fixture because it is the same
  // recorder against the same routes: two harnesses record end to end with the
  // user writing nothing. The cases above are the first harness; these are the
  // second, driven through the same CLI with one flag changed.
  describe("#150: the second harness, and the interface that makes it one", () => {
    it("records a second harness end to end, through the same CLI", async () => {
      const { runId } = await openRun();
      const file = path.join(transcripts, "codex.jsonl");
      writeFileSync(
        file,
        [cxThread(), cxSay("looking at the repo"), cxRun("i1", "npm test"), cxRan("i1", "4 passing"), cxTurn()].join(
          "\n",
        ) + "\n",
      );

      await recorder([
        ...["wrap", "--repo", `${owner}/${repoName}`, "--run", runId, "--harness", "codex"],
        ...["--", "cat", file],
      ]);

      const verify = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/verify`);
      expect(verify.body.ok).toBe(true);
      expect(verify.body.chains_ok).toBe(true);
      expect(verify.body.emitters_ok).toBe(true);

      const sessions = verify.body.sessions as { session_id: string; event_count: number }[];
      expect(sessions).toHaveLength(1);
      // Four, not five: the command's `item.started` and `item.completed` are
      // one tool call, exactly as the claude-code case counts its pair once.
      expect(sessions[0]!.event_count).toBe(4);

      const events = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessions[0]!.session_id}/events`);
      const kinds = (events.body.events as { kind: string; type: string }[]).map((e) => `${e.kind}:${e.type}`);
      expect(kinds).toEqual([
        "custom:codex.thread_started",
        "message:assistant",
        "tool_call:shell",
        "model_call:turn",
      ]);

      // Stored verbatim, and the server never branched on it to get here —
      // which is the invariant the whole readers-in-a-client design protects.
      const session = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessions[0]!.session_id}`);
      expect(session.body.harness).toBe("codex");
    }, 120_000);

    it("refuses a harness it has no reader for, before creating a session", async () => {
      // Defaulting instead would record the stream through the wrong parser: a
      // trajectory of `custom` events that looks like a successful recording and
      // is worthless, discovered days later from the record being relied on.
      const before = listSpooled();
      await expect(
        recorder(["wrap", "--repo", `${owner}/${repoName}`, "--harness", "aider", "--", "true"]),
      ).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("no reader for harness 'aider'") });
      // And nothing was left behind: the reader is resolved before the spool's
      // sidecar is written, so a typo does not leave a spool for `flush` to
      // find forever.
      expect(listSpooled()).toEqual(before);
    }, 120_000);
  });

  // ── #151: the lifecycle nobody has to remember ─────────────────────────
  //
  // The three decisions — start, checkpoint, close — each used to need someone
  // to make a call mid-task. These drive the CLI as a process, in a real
  // checkout pushed to a real ADP, and assert the facts that were previously
  // only available if an agent had been prompted well enough to produce them.
  describe("#151: session lifecycle, driven by what the harness did", () => {
    /**
     * Every checkout these cases make, removed once in `afterAll`.
     *
     * Not at the end of each test: a `rm` in the test body is skipped whenever
     * an assertion above it throws, so the runs that leak are exactly the runs
     * that failed — and `scripts/dev/verify-clean.sh` then warns about stale
     * directories on top of the failure that caused them.
     */
    const checkouts: string[] = [];
    afterAll(async () => {
      for (const dir of checkouts) await rm(dir, { recursive: true, force: true });
    });

    /** A checkout wired to this ADP, so a commit the recorder sees is one ADP can resolve. */
    async function checkout(): Promise<string> {
      const dir = await mkdtemp(path.join(tmpdir(), "adp-e2e-recorder-work-"));
      checkouts.push(dir);
      const url = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
      await execFileAsync("git", ["clone", "-q", url, dir]);
      await execFileAsync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
      await execFileAsync("git", ["config", "user.name", "T"], { cwd: dir });
      return dir;
    }

    async function commitAndPush(dir: string, message: string): Promise<string> {
      writeFileSync(path.join(dir, `f-${Date.now()}.txt`), "work\n");
      await execFileAsync("git", ["add", "-A"], { cwd: dir });
      await execFileAsync("git", ["commit", "-q", "-m", message], { cwd: dir });
      await execFileAsync("git", ["push", "-q", "origin", "HEAD"], { cwd: dir });
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
      return stdout.trim();
    }

    /** The ADP session id of the most recently started spool, read off its sidecar. */
    function newestSpooledSessionId(): string {
      const metas = readdirSync(spoolDir)
        .filter((f) => f.endsWith(".meta.json"))
        .map((f) => JSON.parse(readFileSync(path.join(spoolDir, f), "utf8")) as { sessionId?: string; startedAt: string })
        .filter((m) => typeof m.sessionId === "string")
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      return metas[metas.length - 1]!.sessionId!;
    }

    async function sessionsOf(runId: string): Promise<{ session_id: string }[]> {
      const verify = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/verify`);
      return verify.body.sessions as { session_id: string }[];
    }

    it("suspends the session when the harness did not finish, and leaves a checkpoint to resume from", async () => {
      // The done-when, exactly: killing it produces a suspended session with a
      // usable checkpoint, not an open one. `false` is a harness that exits
      // non-zero, which is what "did not finish" looks like from outside.
      const work = await checkout();
      const sha = await commitAndPush(work, "the work so far");
      const { runId } = await openRun();

      await recorder([
        ...["wrap", "--repo", `${owner}/${repoName}`, "--run", runId, "--dir", work],
        ...["--", "sh", "-c", `printf '%s\\n' '${say("half done").replace(/'/g, "'\\''")}'; exit 3`],
      ]).catch(() => undefined);

      const [session] = await sessionsOf(runId);
      const got = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${session!.session_id}`);
      expect(got.body.status).toBe("suspended");
      const checkpoints = got.body.checkpoints as { git_sha: string; state: unknown }[];
      expect(checkpoints.length).toBeGreaterThan(0);
      expect(checkpoints[checkpoints.length - 1]!.git_sha).toBe(sha);

    }, 180_000);

    it("closes the session when the harness finished, with nobody calling close", async () => {
      const work = await checkout();
      await commitAndPush(work, "done");
      const { runId } = await openRun();
      const file = path.join(transcripts, "clean.jsonl");
      writeFileSync(file, [init(), say("all done")].join("\n") + "\n");

      await recorder([
        ...["wrap", "--repo", `${owner}/${repoName}`, "--run", runId, "--dir", work],
        ...["--", "cat", file],
      ]);

      const [session] = await sessionsOf(runId);
      const got = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${session!.session_id}`);
      expect(got.body.status).toBe("closed");
    }, 180_000);

    it("binds the session to the intent HEAD's trailer names, with no --intent", async () => {
      // The phase rule: an input ADP can derive that a human is supplying is a
      // defect. The trailer #142 established already says which intent the
      // work answers, so the recorder reads it rather than being told.
      //
      // No run here, deliberately — a run would supply the intent itself, and
      // the session would look identical whether or not the trailer worked. So
      // the session is found through the recorder's own spool sidecar, which
      // is a file read rather than an import: `recorder/` stays a package this
      // suite runs and never links against.
      const work = await checkout();
      const issue = await api(`/api/v3/repos/${owner}/${repoName}/issues`, {
        method: "POST",
        body: JSON.stringify({ title: "answer me", body: "via the trailer" }),
      });
      const intentId = issue.body.intent_id as string;
      const number = issue.body.number as number;
      await commitAndPush(work, `Answer it\n\nADP-Intent: #${number}\n`);

      const file = path.join(transcripts, "trailer.jsonl");
      writeFileSync(file, [init(), say("bound")].join("\n") + "\n");
      await recorder([...["wrap", "--repo", `${owner}/${repoName}`, "--dir", work], ...["--", "cat", file]]);

      const sessionId = newestSpooledSessionId();
      const got = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionId}`);
      expect(got.body.intent_id).toBe(intentId);
    }, 180_000);

    it("continues a suspended session across harnesses, and the lineage is walkable", async () => {
      // #151's third done-when, and what #160 needs in order to be a
      // demonstration rather than a script: the chain was never assembled by
      // hand. `--continue` names no session, no checkpoint and no link.
      const work = await checkout();
      await commitAndPush(work, "first half");
      const { runId } = await openRun();

      const first = path.join(transcripts, "harness-a.jsonl");
      writeFileSync(first, [init(), say("first half")].join("\n") + "\n");
      await recorder([
        ...["wrap", "--repo", `${owner}/${repoName}`, "--run", runId, "--dir", work],
        ...["--", "sh", "-c", `cat ${first}; exit 3`],
      ]).catch(() => undefined);

      const second = path.join(transcripts, "harness-b.jsonl");
      writeFileSync(
        second,
        [
          JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
          JSON.stringify({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "second half" } }),
        ].join("\n") + "\n",
      );
      await recorder([
        ...["wrap", "--repo", `${owner}/${repoName}`, "--run", runId, "--dir", work],
        ...["--harness", "codex", "--continue", "--", "cat", second],
      ]);

      const sessions = await sessionsOf(runId);
      expect(sessions.length).toBe(2);
      // Ask the newest session where it came from; the answer is a chain, not
      // a field somebody filled in.
      const latest = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessions[1]!.session_id}`);
      const lineage = latest.body.lineage as { harness: string }[];
      expect(lineage.map((s) => s.harness)).toEqual(["claude-code", "codex"]);
    }, 240_000);
  });
});
