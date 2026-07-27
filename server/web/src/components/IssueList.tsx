import { useEffect, useState } from "react";
import { api, type Connection, type Issue, ApiError } from "../api.js";

export default function IssueList({ conn, onOpen }: { conn: Connection; onOpen: (number: number) => void }) {
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listIssues(conn)
      .then(setIssues)
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, [conn]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!issues) return <div className="empty">Loading…</div>;

  return (
    <>
      <h1>Issues</h1>
      {issues.length === 0 ? (
        <div className="empty">No issues yet.</div>
      ) : (
        <div className="list">
          {issues.map((issue) => (
            <button key={issue.id} className="list-row" onClick={() => onOpen(issue.number)}>
              <span className="num">#{issue.number}</span>
              <span className="title">{issue.title}</span>
              <span className={`pill ${issue.state}`}>{issue.state}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
