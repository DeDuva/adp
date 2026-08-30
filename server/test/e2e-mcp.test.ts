import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDb, type Db } from "../src/db/client.js";
import { identities } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { repoAccessCheck } from "../src/core/repos-lookup.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerChangeRoutes } from "../src/http-rest/changes.js";
import { registerIssueRoutes } from "../src/http-rest/issues.js";
import { registerProposalRoutes } from "../src/http-rest/proposals.js";
import { registerReviewRoutes } from "../src/http-rest/reviews.js";
import { registerOperationRoutes } from "../src/http-rest/operations.js";
import { registerWorkspaceRoutes } from "../src/http-rest/workspaces.js";
import { registerEvidenceRoutes } from "../src/http-rest/evidence.js";
import { registerCandidateSetRoutes } from "../src/http-rest/candidate-sets.js";
import { createAdpClient } from "../src/mcp/client.js";
import { buildMcpServer } from "../src/mcp/server.js";

const execFileAsync = promisify(execFile);

function textOf(result: { content: { type: string; text?: string }[] }): string {
  const first = result.content[0];
  return first && first.type === "text" ? (first.text ?? "") : "";
}

// M1c: the MCP native plane. Every tool is a
// thin wrapper over the real /api/adp REST endpoints — this test runs a real
// Fastify server against real Postgres, a real MCP Client/Server pair
// talking over the SDK's in-memory transport, and the MCP server's real
// HTTP client (src/mcp/client.ts) hitting the real server. Nothing here is
// mocked except the wire between MCP client and server, which is exactly
// what the SDK's InMemoryTransport is for.
describe.skipIf(skipWithoutDb)("M1c: MCP native plane", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  let mcp: Client;
  const owner = `mcp-owner-${Date.now()}`;
  const repoName = "widget";

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-mcp-git-"));
    const gitBackend = new GitBackend(gitRoot);

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerChangeRoutes(app, db, gitBackend, new Signer("e2e-mcp-signing-key"));
    registerIssueRoutes(app, db);
    registerProposalRoutes(app, db, gitBackend, "e2e-test-credential-key", []);
    registerReviewRoutes(app, db);
    registerOperationRoutes(app, db, gitBackend);
    registerWorkspaceRoutes(app, db, gitBackend);
    registerEvidenceRoutes(app, db);
    registerCandidateSetRoutes(app, db, gitBackend);
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "agent", principal: `mcp-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);

    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: repoName }),
    });

    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-mcp-clone-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo hi > README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    const initSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: cloneDir })).stdout.trim();
    await rm(cloneDir, { recursive: true, force: true });

    // No receive-path hooks registered in this suite (it's about the MCP
    // wrapper, not auto-record) — record the change the same way an agent
    // without hooks would, via the plain REST endpoint.
    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/changes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ git_sha: initSha }),
    });

    const client = createAdpClient(`http://127.0.0.1:${port}`, token);
    const mcpServer = buildMcpServer(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    mcp = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([mcp.connect(clientTransport), mcpServer.connect(serverTransport)]);
  });

  afterAll(async () => {
    await mcp.close();
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  // An exact list, not a subset check: the native plane is the product surface
  // agents actually see, so a tool appearing or disappearing should be a
  // deliberate edit here rather than something that slips in unnoticed.
  it("lists exactly the native-plane tools", async () => {
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        // M1c
        "adp_candidates_open",
        "adp_candidates_select",
        "adp_evidence_get",
        "adp_history_query",
        "adp_op_log",
        "adp_undo",
        "adp_workspace_create",
        "adp_workspace_destroy",
        // M3: candidate-set resolution (D1) and sessions (D2)
        "adp_candidates_resolve",
        "adp_checkpoint_create",
        "adp_session_get",
        "adp_session_resume",
        "adp_session_start",
        // Runs and trajectories
        "adp_run_stats",
        "adp_run_trajectory",
        "adp_runs_compare",
        "adp_trajectory_append",
        // #144: the proposal loop, and the intent read that starts it. Before
        // these, an agent restricted to the native plane had to break out to a
        // raw `curl` to open a proposal at all.
        "adp_intent_get",
        "adp_proposal_open",
        "adp_proposal_review",
        "adp_proposal_merge",
      ].sort(),
    );
  });

  it("adp_workspace_create and adp_workspace_destroy round-trip a real branch", async () => {
    const created = await mcp.callTool({
      name: "adp_workspace_create",
      arguments: { owner, repo: repoName, base_ref: "main" },
    });
    expect(created.isError).toBeFalsy();
    const ws = JSON.parse(textOf(created as never)) as { id: string; branch: string };
    expect(ws.branch).toMatch(/^adp\/ws\//);

    const destroyed = await mcp.callTool({
      name: "adp_workspace_destroy",
      arguments: { owner, repo: repoName, workspace_id: ws.id },
    });
    expect(destroyed.isError).toBeFalsy();
  });

  it("adp_evidence_get returns a real, signed change bundle after adp_op_log surfaces it", async () => {
    const opLog = await mcp.callTool({ name: "adp_op_log", arguments: { owner, repo: repoName } });
    expect(opLog.isError).toBeFalsy();
    const ops = JSON.parse(textOf(opLog as never)) as { verb: string; target: string }[];
    const changeOp = ops.find((o) => o.verb === "change.create");
    expect(changeOp).toBeTruthy();
    const sha = changeOp!.target.split("@")[1]!;

    const evidence = await mcp.callTool({
      name: "adp_evidence_get",
      arguments: { owner, repo: repoName, git_sha: sha },
    });
    expect(evidence.isError).toBeFalsy();
    const bundle = JSON.parse(textOf(evidence as never)) as { change: { signature: string } | null };
    expect(bundle.change?.signature).toBeTruthy();
  });

  it("adp_history_query filters by verb, matching the REST API", async () => {
    const res = await mcp.callTool({
      name: "adp_history_query",
      arguments: { owner, repo: repoName, verb: "repo.create" },
    });
    expect(res.isError).toBeFalsy();
    const rows = JSON.parse(textOf(res as never)) as { verb: string }[];
    expect(rows.every((r) => r.verb === "repo.create")).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("adp_undo reverts a real fast-forward merge", async () => {
    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-mcp-pr-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo more >> README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-am", "feature"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "feature"], { cwd: cloneDir });
    await rm(cloneDir, { recursive: true, force: true });

    const createPr = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/pulls`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Add more", head: "feature", base: "main" }),
    });
    const pr = (await createPr.json()) as { number: number };
    const mergeRes = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/pulls/${pr.number}/merge`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(mergeRes.status).toBe(200);

    const opLog = await mcp.callTool({
      name: "adp_history_query",
      arguments: { owner, repo: repoName, verb: "proposal.merge" },
    });
    const mergeOp = (JSON.parse(textOf(opLog as never)) as { id: string }[])[0]!;

    const undone = await mcp.callTool({
      name: "adp_undo",
      arguments: { owner, repo: repoName, operation_id: mergeOp.id },
    });
    expect(undone.isError).toBeFalsy();
    const body = JSON.parse(textOf(undone as never)) as { verb: string };
    expect(body.verb).toBe("proposal.merge.undo");
  });

  // #144: the whole loop over the native plane and nothing else. `gh pr
  // create` is one command; the native plane's equivalent used to be a
  // hand-assembled HTTP request an agent had to be told how to build, in a
  // prompt, correctly, every time — which is the leading hypothesis for arm
  // 2's ADP-MCP trials costing $0.1435 against $0.0848 via `gh`. Every step
  // below is an MCP tool call, deliberately: a `fetch` slipped in here would
  // be the exact gap this closes.
  it("opens, reviews and merges a proposal through MCP alone, starting from the intent", async () => {
    const issueRes = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/issues`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Describe the widget", body: "It only has a heading." }),
    });
    const issue = (await issueRes.json()) as { number: number; intent_id: string };

    // The way in: nothing under /api/adp mints an intent, so without this the
    // agent needs a curl before it can start.
    const read = await mcp.callTool({
      name: "adp_intent_get",
      arguments: { owner, repo: repoName, number: issue.number },
    });
    expect(read.isError).toBeFalsy();
    const intent = JSON.parse(textOf(read as never)) as { intent_id: string; title: string };
    expect(intent.intent_id).toBe(issue.intent_id);
    expect(intent.title).toBe("Describe the widget");

    const branch = `mcp-loop-${Date.now()}`;
    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-mcp-loop-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("git", ["checkout", "-b", branch], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo 'A widget, described.' >> README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-am", "describe the widget"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", branch], { cwd: cloneDir });
    await rm(cloneDir, { recursive: true, force: true });

    const opened = await mcp.callTool({
      name: "adp_proposal_open",
      arguments: { owner, repo: repoName, title: "Describe the widget", head: branch, base: "main" },
    });
    expect(opened.isError).toBeFalsy();
    const proposal = JSON.parse(textOf(opened as never)) as { number: number };
    expect(proposal.number).toBeGreaterThan(0);

    const reviewed = await mcp.callTool({
      name: "adp_proposal_review",
      arguments: { owner, repo: repoName, number: proposal.number, state: "approved", body: "lgtm" },
    });
    expect(reviewed.isError).toBeFalsy();
    expect((JSON.parse(textOf(reviewed as never)) as { state: string }).state).toBe("approved");

    const merged = await mcp.callTool({
      name: "adp_proposal_merge",
      arguments: { owner, repo: repoName, number: proposal.number },
    });
    expect(merged.isError).toBeFalsy();
    expect((JSON.parse(textOf(merged as never)) as { merged: boolean }).merged).toBe(true);
  }, 120_000);

  // The refusal shape matters more here than anywhere else: it is the one
  // response an agent is guaranteed to see on a well-configured instance, and
  // an agent that cannot read it burns a turn guessing. `message` alone says
  // "Land policy not satisfied" and nothing an agent can act on, so the typed
  // body goes through intact.
  it("adp_proposal_merge surfaces the typed land-policy refusal, not a flattened error string", async () => {
    const gatedRepo = "gated";
    const gated = Fastify({ logger: false });
    gated.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await gated.register(authPlugin(db));
    const gatedGit = new GitBackend(gitRoot);
    registerRepoRoutes(gated, db, gatedGit, "https://adp.example.com");
    registerProposalRoutes(gated, db, gatedGit, "e2e-test-credential-key", ["gates_green"]);
    registerGitHttpRoutes(gated, repoAccessCheck(db), gatedGit);
    await gated.listen({ host: "127.0.0.1", port: 0 });
    const gatedAddress = gated.server.address();
    const gatedPort = typeof gatedAddress === "object" && gatedAddress ? gatedAddress.port : 0;

    const gatedMcp = new Client({ name: "test-client-gated", version: "0.0.0" });
    try {
      await fetch(`http://127.0.0.1:${gatedPort}/api/v3/repos/${owner}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: gatedRepo }),
      });

      const dir = await mkdtemp(path.join(tmpdir(), "adp-e2e-mcp-gated-"));
      const url = `http://x-access-token:${token}@127.0.0.1:${gatedPort}/${owner}/${gatedRepo}.git`;
      await execFileAsync("git", ["clone", url, dir]);
      await execFileAsync("git", ["checkout", "-B", "main"], { cwd: dir });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
      // A repo declaring no gates satisfies gates_green vacuously and would
      // prove nothing here.
      await execFileAsync("sh", ["-c", "printf 'gates:\\n  - test\\nland:\\n  require: []\\n' > adp.yaml"], { cwd: dir });
      await execFileAsync("git", ["add", "."], { cwd: dir });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
      await execFileAsync("git", ["push", "origin", "main"], { cwd: dir });
      await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: dir });
      await execFileAsync("sh", ["-c", "echo more >> README.md"], { cwd: dir });
      await execFileAsync("git", ["add", "."], { cwd: dir });
      await execFileAsync("git", ["commit", "-m", "feature"], { cwd: dir });
      await execFileAsync("git", ["push", "origin", "feature"], { cwd: dir });
      const sha = (await execFileAsync("git", ["rev-parse", "feature"], { cwd: dir })).stdout.trim();
      await rm(dir, { recursive: true, force: true });

      const gatedClient = createAdpClient(`http://127.0.0.1:${gatedPort}`, token);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([gatedMcp.connect(clientTransport), buildMcpServer(gatedClient).connect(serverTransport)]);

      const opened = await gatedMcp.callTool({
        name: "adp_proposal_open",
        arguments: { owner, repo: gatedRepo, title: "gated", head: "feature", base: "main" },
      });
      expect(opened.isError).toBeFalsy();
      const number = (JSON.parse(textOf(opened as never)) as { number: number }).number;

      const refused = await gatedMcp.callTool({
        name: "adp_proposal_merge",
        arguments: { owner, repo: gatedRepo, number },
      });
      expect(refused.isError).toBe(true);

      // Parseable, not prose: an agent reads the requirement and the command
      // off the response rather than pattern-matching an error message.
      const body = JSON.parse(textOf(refused as never)) as {
        message: string;
        unmet: string[];
        unmet_detail: { requirement: string; command?: string }[];
      };
      expect(body.message).toMatch(/Land policy/);
      const gate = body.unmet_detail.find((u) => u.requirement === "gates_green")!;
      expect(gate.command).toBe(
        `adp gate report --repo ${owner}/${gatedRepo} --sha ${sha} --name test --status success`,
      );
      expect(body.unmet.join(" ")).toContain("adp gate report");
    } finally {
      await gatedMcp.close().catch(() => {});
      await gated.close();
    }
  }, 120_000);

  it("adp_candidates_open and adp_candidates_select fan out proposals against one intent and pick a winner", async () => {
    const issueRes = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/issues`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Speed up the build" }),
    });
    const issue = (await issueRes.json()) as { intent_id: string };

    const open = await mcp.callTool({
      name: "adp_candidates_open",
      arguments: { owner, repo: repoName, intent_id: issue.intent_id },
    });
    expect(open.isError).toBeFalsy();
    const candidateSet = JSON.parse(textOf(open as never)) as { id: string; candidates: unknown[] };
    expect(candidateSet.candidates).toEqual([]);

    async function openProposal(branch: string) {
      const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-mcp-cand-"));
      const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
      await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
      await execFileAsync("git", ["checkout", "-b", branch], { cwd: cloneDir });
      await execFileAsync("sh", ["-c", `echo ${branch} >> README.md`], { cwd: cloneDir });
      await execFileAsync("git", ["commit", "-am", branch], { cwd: cloneDir });
      await execFileAsync("git", ["push", "origin", branch], { cwd: cloneDir });
      await rm(cloneDir, { recursive: true, force: true });

      const prRes = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/pulls`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: branch, head: branch, base: "main", candidate_set_id: candidateSet.id }),
      });
      return (await prRes.json()) as { id: string; number: number };
    }

    const candidateA = await openProposal("cand-a");
    const candidateB = await openProposal("cand-b");

    const opened = await mcp.callTool({
      name: "adp_history_query",
      arguments: { owner, repo: repoName, verb: "candidateset.open" },
    });
    expect((JSON.parse(textOf(opened as never)) as { id: string }[]).length).toBeGreaterThan(0);

    const selected = await mcp.callTool({
      name: "adp_candidates_select",
      arguments: { owner, repo: repoName, candidate_set_id: candidateSet.id, candidate_id: candidateB.id },
    });
    expect(selected.isError).toBeFalsy();
    const resolvedSet = JSON.parse(textOf(selected as never)) as { selected_proposal_id: string };
    expect(resolvedSet.selected_proposal_id).toBe(candidateB.id);
    void candidateA;
  });
});
