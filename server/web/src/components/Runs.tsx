import { useEffect, useState } from "react";
import { api, ApiError, RUN_STATUSES, type Connection, type RunRow } from "../api.js";
import { formatCost, formatDuration, formatTokens, runArm, shortSha } from "../format.js";

// #156. The supervision UI had six views and none of them was a run, a session,
// a trajectory, a checkpoint or an eval — so the entire M3 surface, the part of
// ADP that has no GitHub analogue and is the reason to run it, was reachable
// only by someone writing an API client.
//
// The list is `/runs/compare` with no intent filter rather than `/runs`: the
// aggregates a list wants — events, cost, duration, tool failures, the latest
// eval — are already computed there, server-side, in one request. Using `/runs`
// and fetching stats per row would be fifty round trips to render one table.

export default function RunList({ conn, onOpen }: { conn: Connection; onOpen: (id: string) => void }) {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [status, setStatus] = useState<string>("");
  const [intentId, setIntentId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRuns(null);
    setError(null);
    api
      .listRuns(conn, { status: status || undefined, intent_id: intentId.trim() || undefined })
      .then((res) => live && setRuns(res.runs))
      .catch((err) => live && setError(err instanceof ApiError ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [conn, status, intentId]);

  return (
    <>
      <h1>Runs</h1>
      <div className="meta">
        One orchestrator assignment against one intent. Every agent in it is a session, and every session's
        trajectory is hash-chained — open a run to read what the agent actually did.
      </div>

      <div className="filters">
        <label className="field">
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">any</option>
            {RUN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Intent</span>
          <input
            value={intentId}
            placeholder="intent id"
            onChange={(e) => setIntentId(e.target.value)}
            className="mono"
          />
        </label>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {!runs ? (
        <div className="empty">Loading…</div>
      ) : runs.length === 0 ? (
        <div className="empty">
          No runs{status || intentId ? " match this filter" : " yet"}. A run is opened against an intent by an
          orchestrator — <code>POST /api/adp/repos/…/runs</code>, or <code>adp_run_open</code> over MCP.
        </div>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Arm</th>
              <th>Status</th>
              <th className="num">Events</th>
              <th className="num">Tools</th>
              <th className="num">Tokens</th>
              <th className="num">Cost</th>
              <th className="num">Duration</th>
              <th>Score</th>
              <th>Landed</th>
              <th>Opened</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.runId} className="clickable" onClick={() => onOpen(r.runId)}>
                <td>
                  <div>{runArm(r.labels)}</div>
                  <div className="meta mono">{r.externalRef ?? r.orchestrator}</div>
                </td>
                <td>
                  <span className={`pill ${r.status === "closed" ? "merged" : r.status === "abandoned" ? "closed" : "open"}`}>
                    {r.status}
                  </span>
                </td>
                <td className="num mono">{r.events}</td>
                {/* Failures beside the count rather than as a ratio: "12 (3 failed)"
                    is a fact, a percentage is a summary of one. */}
                <td className="num mono">
                  {r.toolCalls}
                  {r.toolFailures > 0 && <span className="bad"> ({r.toolFailures} failed)</span>}
                </td>
                <td className="num mono">{formatTokens(r.tokensIn + r.tokensOut)}</td>
                <td className="num mono">{formatCost(r.costMicroUsd)}</td>
                <td className="num mono">{formatDuration(r.durationMs)}</td>
                {/* An unscored run was never ranked, which is a different claim
                    from ranking at the bottom — the same rule the candidate-set
                    view already follows. */}
                <td className="mono">{r.eval?.score ?? "—"}</td>
                <td className="mono">{shortSha(r.finalGitSha)}</td>
                <td className="meta">{new Date(r.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
