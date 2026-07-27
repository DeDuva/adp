import { useEffect, useState } from "react";
import { api, type Connection, type Issue, type IssueComment, ApiError } from "../api.js";

export default function IssueDetail({
  conn,
  number,
  onBack,
}: {
  conn: Connection;
  number: number;
  onBack: () => void;
}) {
  const [issue, setIssue] = useState<Issue | null>(null);
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIssue(null);
    Promise.all([api.getIssue(conn, number), api.listIssueComments(conn, number)])
      .then(([i, c]) => {
        setIssue(i);
        setComments(c);
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
            <span className={`pill ${issue.state}`}>{issue.state}</span> opened by {issue.user.login} ·{" "}
            {new Date(issue.created_at).toLocaleString()}
          </div>
          {issue.body && (
            <div className="card">
              <div className="body-text">{issue.body}</div>
            </div>
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
