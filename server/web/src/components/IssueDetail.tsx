import { useEffect, useState } from "react";
import { api, type Connection, type Issue, type IssueComment, type RunRow, ApiError } from "../api.js";
import { formatCost, formatDuration, runArm, shortSha } from "../format.js";

export default function IssueDetail({
  conn,
  number,
  onBack,
  onOpenRun,
}: {
  conn: Connection;
  number: number;
  onBack: () => void;
  onOpenRun: (id: string) => void;
}) {
  const [issue, setIssue] = useState<Issue | null>(null);
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIssue(null);
    setRuns([]);
    Promise.all([api.getIssue(conn, number), api.listIssueComments(conn, number)])
      .then(([i, c]) => {
        setIssue(i);
        setComments(c);
        // #157, the other direction of the evidence view's edge: an issue
        // carries an intent, and the runs are keyed by it. A repo with no runs
        // renders nothing rather than an empty section, so this costs an
        // untouched deployment one request and no clutter.
        if (!i.intent_id) return;
        api
          .listRuns(conn, { intent_id: i.intent_id })
          .then((res) => setRuns(res.runs))
          .catch(() => setRuns([]));
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, [conn, number]);

  return (
    <>
      <button className="back" onClick={onBack}>
        ← Issues
      </button>
      {error && <div className="error-banner">{error}</div>}
      {!issue ? (
        <div className="empty">Loading…</div>
      ) : (
        <>
          <h1>
            {issue.title} <span className="mono">#{issue.number}</span>
          </h1>
          <div className="meta">
            <span className={`pill ${issue.state}`}>{issue.state}</span>{" "}
            {/* The read routes serialize no author — `serializeIssue` is passed
                an empty login on GET, unlike on create — so this said "opened
                by ·" with a gap where a name should be, which reads as broken
                rather than as absent. Claim only what the API actually says. */}
            {issue.user.login ? `opened by ${issue.user.login} · ` : "opened "}
            {new Date(issue.created_at).toLocaleString()}
          </div>
          {issue.body && (
            <div className="card">
              <div className="body-text">{issue.body}</div>
            </div>
          )}

          {runs.length > 0 && (
            <>
              <h3>Attempts ({runs.length})</h3>
              <div className="meta">
                Runs against this issue's intent. Where several tried the same thing, this is the comparison —
                each row pairing what it produced with what it cost.
              </div>
              <table className="grid">
                <thead>
                  <tr>
                    <th>Arm</th>
                    <th>Status</th>
                    <th className="num">Events</th>
                    <th className="num">Cost</th>
                    <th className="num">Duration</th>
                    <th>Score</th>
                    <th>Landed</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.runId} className="clickable" onClick={() => onOpenRun(r.runId)}>
                      <td>{runArm(r.labels) === "—" ? r.orchestrator : runArm(r.labels)}</td>
                      <td>
                        <span className={`pill ${r.status === "closed" ? "merged" : r.status === "abandoned" ? "closed" : "open"}`}>
                          {r.status}
                        </span>
                      </td>
                      <td className="num mono">{r.events}</td>
                      <td className="num mono">{formatCost(r.costMicroUsd)}</td>
                      <td className="num mono">{formatDuration(r.durationMs)}</td>
                      <td className="mono">{r.eval?.score ?? "—"}</td>
                      <td className="mono">{shortSha(r.finalGitSha)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <h3>Comments</h3>
          {comments.length === 0 ? (
            <div className="empty">No comments.</div>
          ) : (
            comments.map((c) => (
              <div className="card" key={c.id}>
                <div className="meta">{new Date(c.created_at).toLocaleString()}</div>
                <div className="body-text">{c.body}</div>
              </div>
            ))
          )}
        </>
      )}
    </>
  );
}
