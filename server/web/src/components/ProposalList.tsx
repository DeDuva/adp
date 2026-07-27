import { useEffect, useState } from "react";
import { api, type Connection, type Proposal, ApiError } from "../api.js";

export default function ProposalList({ conn, onOpen }: { conn: Connection; onOpen: (number: number) => void }) {
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listProposals(conn)
      .then(setProposals)
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, [conn]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!proposals) return <div className="empty">Loading…</div>;

  return (
    <>
      <h1>Pull requests</h1>
      {proposals.length === 0 ? (
        <div className="empty">No pull requests yet.</div>
      ) : (
        <div className="list">
          {proposals.map((p) => (
            <button key={p.id} className="list-row" onClick={() => onOpen(p.number)}>
              <span className="num">#{p.number}</span>
              <span className="title">{p.title}</span>
              <span className="mono meta" style={{ marginBottom: 0 }}>
                {p.head.ref} → {p.base.ref}
              </span>
              <span className={`pill ${p.state}`}>{p.state}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
