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
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerChangeRoutes } from "../src/http-rest/changes.js";
import { registerIssueRoutes } from "../src/http-rest/issues.js";
import { registerProposalRoutes } from "../src/http-rest/proposals.js";
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

// M1c: the MCP native plane (docs/pragmatic_mvp.md Tier 4). Every tool is a
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
    registerRepoRoutes(app, db, gitBackend);
    registerChangeRoutes(app, db, gitBackend, new Signer("e2e-mcp-signing-key"));
    registerIssueRoutes(app, db);
    registerProposalRoutes(app, db, gitBackend, []);
    registerOperationRoutes(app, db, gitBackend);
    registerWorkspaceRoutes(app, db, gitBackend);
    registerEvidenceRoutes(app, db);
    registerCandidateSetRoutes(app, db);
    registerGitHttpRoutes(app, gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "agent", principal: `mcp-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);

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

  it("lists all 8 native-plane tools", async () => {
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "adp_candidates_open",
        "adp_candidates_select",
        "adp_evidence_get",
        "adp_history_query",
        "adp_op_log",
        "adp_undo",
        "adp_workspace_create",
        "adp_workspace_destroy",
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
