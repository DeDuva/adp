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
        selection_policy: z
          .enum(["manual", "first_green", "best_score"])
          .optional()
          .describe(
            "How adp_candidates_resolve picks the winner. 'manual' (default) needs an explicit " +
              "selection; 'first_green' takes the earliest candidate that satisfies land policy; " +
              "'best_score' takes the highest 'score' gate result, ties going to the earliest candidate.",
          ),
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

  server.registerTool(
    "adp_candidates_resolve",
    {
      description:
        "Resolve a candidate set: pick the winner by the set's selection policy, land it (squash — one " +
        "landed change per set), and reclaim the losing candidates' workspaces. Losers are closed and " +
        "their branches deleted, but stay queryable in the history. This is the call that finishes a " +
        "fan-out; adp_candidates_select only records a choice.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        candidate_set_id: z.string().uuid(),
        candidate_id: z
          .string()
          .uuid()
          .optional()
          .describe("Resolve this specific candidate regardless of policy. Required for an unselected 'manual' set."),
      },
    },
    async ({ owner, repo, candidate_set_id, candidate_id }) => {
      const res = await client.post(`/api/adp/repos/${owner}/${repo}/candidate-sets/${candidate_set_id}/resolve`, {
        proposal_id: candidate_id,
      });
      return res.ok ? ok(res.body) : err(res.message);
    },
  );

  // Sessions and checkpoints (M3 / D2). The point of these being MCP tools is
  // that any harness can drive them — a session started through one harness is
  // resumed through another with no coordination between the two beyond ADP.
  server.registerTool(
    "adp_session_start",
    {
      description:
        "Start a session — a unit of agent work that outlives any one harness. `harness` is a free-form " +
        "identifier for whatever is driving (ADP never branches on its value).",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        harness: z.string().describe("e.g. 'claude-code', 'openhands'"),
        intent_id: z.string().uuid().optional(),
        workspace_id: z.string().uuid().optional(),
      },
    },
    async ({ owner, repo, harness, intent_id, workspace_id }) => {
      const res = await client.post(`/api/adp/repos/${owner}/${repo}/sessions`, {
        harness,
        intent_id,
        workspace_id,
      });
      return res.ok ? ok(res.body) : err(res.message);
    },
  );

  server.registerTool(
    "adp_checkpoint_create",
    {
      description:
        "Checkpoint a session at a commit, with opaque harness state. The checkpoint is signed (DSSE), and " +
        "its signature is verified before any resume — so state written by one harness can be trusted by another.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        session_id: z.string().uuid(),
        git_sha: z.string().describe("The workspace tip at checkpoint time"),
        state: z.unknown().optional().describe("Opaque resume state; ADP never parses it"),
      },
    },
    async ({ owner, repo, session_id, git_sha, state }) => {
      const res = await client.post(`/api/adp/repos/${owner}/${repo}/sessions/${session_id}/checkpoints`, {
        git_sha,
        state: state ?? null,
      });
      return res.ok ? ok(res.body) : err(res.message);
    },
  );

  server.registerTool(
    "adp_session_resume",
    {
      description:
        "Resume a session under a (possibly different) harness. Verifies the checkpoint's signature, forks a " +
        "workspace at its commit, and creates a new session linked to the old one — one continuous signed " +
        "history across both harnesses. Defaults to the session's latest checkpoint.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        session_id: z.string().uuid(),
        harness: z.string().describe("The harness resuming the work"),
        checkpoint_id: z.string().uuid().optional(),
      },
    },
    async ({ owner, repo, session_id, harness, checkpoint_id }) => {
      const res = await client.post(`/api/adp/repos/${owner}/${repo}/sessions/${session_id}/resume`, {
        harness,
        checkpoint_id,
      });
      return res.ok ? ok(res.body) : err(res.message);
    },
  );

  server.registerTool(
    "adp_session_get",
    {
      description:
        "A session with its checkpoints and its full resume lineage — the chain back to the session that " +
        "started the work, however many harnesses it passed through.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        session_id: z.string().uuid(),
      },
    },
    async ({ owner, repo, session_id }) => {
      const res = await client.get(`/api/adp/repos/${owner}/${repo}/sessions/${session_id}`);
      return res.ok ? ok(res.body) : err(res.message);
    },
  );

  // The trajectory tools. An agent reading its own run back is the point: the
  // recorded trajectory is only worth the write cost if something can consume
  // it, and the first consumer is the agent deciding what to do next.
  server.registerTool(
    "adp_trajectory_append",
    {
      description:
        "Append to a session's trajectory — messages, model calls, tool executions, handoffs, commits, and test " +
        "results. Batched; supply client_event_id to make a retry idempotent, and a contiguous producer_seq " +
        "(on every event of the batch, or none) to make a dropped event detectable.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        session_id: z.string(),
        events: z
          .array(
            z.object({
              kind: z.enum(["message", "model_call", "tool_call", "handoff", "commit", "test_result", "custom"]),
              type: z.string().optional(),
              payload: z.unknown().optional(),
              status: z.enum(["success", "failure", "error", "rejected", "skipped"]).optional(),
              model: z.string().optional(),
              tokens_in: z.number().int().nonnegative().optional(),
              tokens_out: z.number().int().nonnegative().optional(),
              cost_micro_usd: z.number().int().nonnegative().optional(),
              duration_ms: z.number().int().nonnegative().optional(),
              git_sha: z.string().optional(),
              related_session_id: z.string().optional(),
              client_event_id: z.string().optional(),
              producer_seq: z.number().int().positive().optional(),
              occurred_at: z.string().optional(),
            }),
          )
          .min(1),
        producer_id: z.string().optional(),
      },
    },
    async ({ owner, repo, session_id, events, producer_id }) => {
      const res = await client.post(`/api/adp/repos/${owner}/${repo}/sessions/${session_id}/events`, {
        events,
        ...(producer_id ? { producer_id } : {}),
      });
      return res.ok ? ok(res.body) : err(res.message);
    },
  );

  server.registerTool(
    "adp_run_trajectory",
    {
      description:
        "A run's whole trajectory, merged across its agents' sessions in the order things actually happened. " +
        "Filter by kind to read just the tool calls, just the handoffs, or just the test results.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        run_id: z.string(),
        kinds: z.string().optional().describe("Comma-separated: message,model_call,tool_call,handoff,commit,test_result"),
        limit: z.number().int().positive().max(2000).optional(),
        offset: z.number().int().nonnegative().optional(),
      },
    },
    async ({ owner, repo, run_id, ...query }) => {
      const res = await client.get(`/api/adp/repos/${owner}/${repo}/runs/${run_id}/trajectory`, query);
      return res.ok ? ok(res.body) : err(res.message);
    },
  );

  server.registerTool(
    "adp_run_stats",
    {
      description:
        "What a run cost and what it spent it on: events and tokens by kind, per-tool call and failure counts, " +
        "per-model spend, the handoff graph, and the commits it produced.",
      inputSchema: { owner: z.string(), repo: z.string(), run_id: z.string() },
    },
    async ({ owner, repo, run_id }) => {
      const res = await client.get(`/api/adp/repos/${owner}/${repo}/runs/${run_id}/stats`);
      return res.ok ? ok(res.body) : err(res.message);
    },
  );

  server.registerTool(
    "adp_runs_compare",
    {
      description:
        "N runs against one intent, each pairing its attested eval score with what the trajectory cost to produce " +
        "it. Ranked by score; unscored runs sort last, because unmeasured is not the same as scoring zero.",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        intent_id: z.string().optional(),
        eval: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async ({ owner, repo, ...query }) => {
      const res = await client.get(`/api/adp/repos/${owner}/${repo}/runs/compare`, query);
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
