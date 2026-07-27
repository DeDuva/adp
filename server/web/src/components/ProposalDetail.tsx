import { useEffect, useState } from "react";
import { api, type Connection, type Proposal, type Review, type FileChange, type GateResult, ApiError } from "../api.js";

export default function ProposalDetail({
  conn,
  number,
  onBack,
  onViewEvidence,
}: {
  conn: Connection;
  number: number;
  onBack: () => void;
  onViewEvidence: (sha: string) => void;
}) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [files, setFiles] = useState<FileChange[]>([]);
  const [gates, setGates] = useState<GateResult[]>([]);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setProposal(null);
    setDiff(null);
    Promise.all([api.getProposal(conn, number), api.listReviews(conn, number), api.listFiles(conn, number)])
      .then(([p, r, f]) => {
        setProposal(p);
        setReviews(r);
        setFiles(f);
        return api.listGatesForSha(conn, p.head.sha).catch(() => []);
      })
      .then(setGates)
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, [conn, number]);

  async function showDiff() {
    try {
      setDiff(await api.getDiff(conn, number));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <>
      <button className="back" onClick={onBack}>
        ← Pull requests
      </button>
      {error && <div className="error-banner">{error}</div>}
      {!proposal ? (
        <div className="empty">Loading…</div>
      ) : (
        <>
          <h1>
            {proposal.title} <span className="mono">#{proposal.number}</span>
          </h1>
          <div className="meta">
            <span className={`pill ${proposal.state}`}>{proposal.state}</span>{" "}
            <span className="mono">
              {proposal.head.ref} → {proposal.base.ref}
            </span>{" "}
            · head <span className="mono">{proposal.head.sha.slice(0, 10)}</span>{" "}
            <button className="btn" style={{ marginLeft: "0.5rem" }} onClick={() => onViewEvidence(proposal.head.sha)}>
              View evidence
            </button>
          </div>
          {proposal.body && (
            <div className="card">
              <div className="body-text">{proposal.body}</div>
            </div>
          )}

          <h3>Reviews</h3>
          {reviews.length === 0 ? (
            <div className="empty">No reviews yet.</div>
          ) : (
            reviews.map((r) => (
              <div className="card" key={r.id}>
                <span className={`pill ${r.state}`}>{r.state.replace("_", " ")}</span>
                <div className="body-text" style={{ marginTop: "0.4rem" }}>
                  {r.body}
                </div>
              </div>
            ))
          )}

          <h3>Gate results (head commit)</h3>
          {gates.length === 0 ? (
            <div className="empty">No gates reported for this commit.</div>
          ) : (
            <table className="gate-table">
              <thead>
                <tr>
                  <th>Gate</th>
                  <th>Status</th>
                  <th>Summary</th>
                  <th>Reported</th>
                </tr>
              </thead>
              <tbody>
                {gates.map((g) => (
                  <tr key={g.id}>
                    <td>{g.name}</td>
                    <td>
                      <span className={`pill ${g.status}`}>{g.status}</span>
                    </td>
                    <td>{g.summary}</td>
                    <td>{new Date(g.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Files changed ({files.length})</h3>
          {files.length === 0 ? (
            <div className="empty">No files changed.</div>
          ) : (
            <div className="list">
              {files.map((f) => (
                <div className="list-row" key={f.filename} style={{ cursor: "default" }}>
                  <span className="title mono">{f.filename}</span>
                  <span className="meta" style={{ marginBottom: 0 }}>
                    {f.status}
                  </span>
                </div>
              ))}
            </div>
          )}
          {diff === null ? (
            <button className="btn" style={{ marginTop: "0.75rem" }} onClick={showDiff}>
              Load diff
            </button>
          ) : (
            <pre className="card mono" style={{ overflowX: "auto", marginTop: "0.75rem" }}>
              {diff || "(empty diff)"}
            </pre>
          )}
        </>
      )}
    </>
  );
}
