import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createAdpClient, type AdpClient } from "./client.js";

// The native plane's MCP surface (docs/pragmatic_mvp.md Tier 4: "ADP REST +
// MCP (~8 tools)"). Every tool below is a thin wrapper over the same
// /api/adp REST endpoints a human or script could call directly — this
// server holds no domain logic of its own, only protocol translation. That
// keeps "what can undo do" defined in exactly one place (core/undo.ts),
// not duplicated here.
//
// adp_candidates_open/select wrap the candidate-set data model
// (core/candidate-sets.ts, http-rest/candidate-sets.ts): opening a set
// creates a row against an intent, proposals join it via candidate_set_id
// at creation time, and selecting records the winner without touching the
// other candidates' state.
export function buildMcpServer(client: AdpClient): McpServer {
  const server = new McpServer({ name: "adp-native", version: "0.1.0" });

  function ok(data: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
  function err(message: string) {
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }

  server.registerTool(
    "adp_workspace_create",
    {
      description: "Create a workspace (an isolated branch) off a base ref, for an agent to work in.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        base_ref: z.string().describe("Branch or ref to create the workspace from, e.g. 'main'"),
        ttl_hours: z.number().positive().optional().describe("Optional time-to-live before GC"),
      },
    },
    async ({ owner, repo, base_ref, ttl_hours }) => {
      const res = await client.post(`/api/adp/repos/${owner}/${repo}/workspaces`, {
        base_ref,
        ttl_hours,
      });
      return res.ok ? ok(res.body) : err(res.message);
    },
  );

  server.registerTool(
    "adp_workspace_destroy",
    {
      description: "Destroy a workspace, deleting its branch.",
      inputSchema: { owner: z.string(), repo: z.string(), workspace_id: z.string() },
    },
    async ({ owner, repo, workspace_id }) => {
      const res = await client.delete(`/api/adp/repos/${owner}/${repo}/workspaces/${workspace_id}`);
      return res.ok ? ok({ destroyed: true }) : err(res.message);
    },
  );

  server.registerTool(
    "adp_history_query",
    {
      description:
        "Who did what and when, over a repo's operation log — filter by actor, verb, a date range, or a file path " +
        "(matches commit-scoped operations whose commit touched that path or a path under it).",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        actor: z.string().uuid().optional(),
        verb: z.string().optional(),
        since: z.string().datetime().optional(),
        until: z.string().datetime().optional(),
        path: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async ({ owner, repo, ...query }) => {
      const res = await client.get(`/api/adp/repos/${owner}/${repo}/operations`, query);
      return res.ok ? ok(res.body) : err(res.message);
    },
  );

  server.registerTool(
    "adp_op_log",
    {
      description: "Raw operation log entries for a repo (same data as adp_history_query, unfiltered by default).",
      inputSchema: { owner: z.string(), repo: z.string(), limit: z.number().int().positive().max(200).optional() },
    },
    async ({ owner, repo, limit }) => {
      const res = await client.get(`/api/adp/repos/${owner}/${repo}/operations`, { limit });
      return res.ok ? ok(res.body) : err(res.message);
    },
  );

  server.registerTool(
    "adp_evidence_get",
    {
      description: "The full signed evidence bundle for a commit: its change record and every gate result reported for it.",
      inputSchema: { owner: z.string(), repo: z.string(), git_sha: z.string() },
    },
    async ({ owner, repo, git_sha }) => {
      const res = await client.get(`/api/adp/repos/${owner}/${repo}/evidence/${git_sha}`);
      return res.ok ? ok(res.body) : err(res.message);
    },
  );

  server.registerTool(
    "adp_undo",
    {
      description:
        "Undo an operation by id — currently only supports reverting a fast-forward merge " +
        "(verb 'proposal.merge'), and only if the branch hasn't moved since.",
      inputSchema: { owner: z.string(), repo: z.string(), operation_id: z.string() },
    },
    async ({ owner, repo, operation_id }) => {
      const res = await client.post(`/api/adp/repos/${owner}/${repo}/operations/${operation_id}/undo`, {});
      return res.ok ? ok(res.body) : err(res.message);
    },
  );

  server.registerTool(
    "adp_candidates_open",
    {
      description:
        "Open a candidate set against one intent — proposals then join it by passing candidate_set_id " +
        "when they're created (fan out N solutions to compare).",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        intent_id: z.string().uuid(),
        selection_policy: z.string().optional().describe("Defaults to 'manual'"),
      },
    },
    async ({ owner, repo, intent_id, selection_policy }) => {
      const res = await client.post(`/api/adp/repos/${owner}/${repo}/candidate-sets`, {
        intent_id,
        selection_policy,
      });
      return res.ok ? ok(res.body) : err(res.message);
    },
  );

  server.registerTool(
    "adp_candidates_select",
    {
      description: "Select the winning candidate (a proposal already in the set) from a candidate set.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        candidate_set_id: z.string().uuid(),
        candidate_id: z.string().uuid().describe("The proposal id to select as the winner"),
      },
    },
    async ({ owner, repo, candidate_set_id, candidate_id }) => {
      const res = await client.post(`/api/adp/repos/${owner}/${repo}/candidate-sets/${candidate_set_id}/select`, {
        proposal_id: candidate_id,
      });
      return res.ok ? ok(res.body) : err(res.message);
    },
  );

  return server;
}

async function main() {
  const baseUrl = process.env.ADP_SERVER_URL;
  const token = process.env.ADP_TOKEN;
  if (!baseUrl || !token) {
    console.error("Usage: ADP_SERVER_URL=... ADP_TOKEN=... node dist/mcp/server.js");
    process.exit(1);
  }

  const client = createAdpClient(baseUrl, token);
  const server = buildMcpServer(client);
  await server.connect(new StdioServerTransport());
}

// Only run as a standalone process when invoked directly (`tsx
// src/mcp/server.ts` / the built dist entry) — importing buildMcpServer for
// tests must not also start a stdio server fighting for stdin.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
