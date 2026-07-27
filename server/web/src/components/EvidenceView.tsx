import { useEffect, useState } from "react";
import { api, type Connection, type EvidenceBundle, ApiError } from "../api.js";

export default function EvidenceView({ conn, sha, onBack }: { conn: Connection; sha: string; onBack: () => void }) {
  const [bundle, setBundle] = useState<EvidenceBundle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBundle(null);
    api
      .getEvidence(conn, sha)
      .then(setBundle)
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, [conn, sha]);

  return (
    <>
      <button className="back" onClick={onBack}>
        ← Back
      </button>
      {error && <div className="error-banner">{error}</div>}
      {!bundle ? (
        <div className="empty">Loading…</div>
      ) : (
        <>
          <h1>
            Evidence <span className="mono">{sha.slice(0, 12)}</span>
          </h1>

          <h3>Change (intent, provenance, signature)</h3>
          {!bundle.change ? (
            <div className="empty">No signed change record for this commit.</div>
          ) : (
            <div className="card">
              <div className="meta">Recorded {new Date(bundle.change.created_at).toLocaleString()}</div>
              <div>
                <strong>Provenance</strong>
                <pre className="mono" style={{ margin: "0.4rem 0", overflowX: "auto" }}>
                  {JSON.stringify(bundle.change.provenance, null, 2)}
                </pre>
              </div>
              <div>
                <strong>Signature</strong>
                <div className="mono" style={{ wordBreak: "break-all", fontSize: "0.78rem", marginTop: "0.3rem" }}>
                  {bundle.change.signature}
                </div>
              </div>
            </div>
          )}

          <h3>Gate attestations ({bundle.gates.length})</h3>
          {bundle.gates.length === 0 ? (
            <div className="empty">No gate results reported for this commit.</div>
          ) : (
            bundle.gates.map((g, i) => (
              <div className="card" key={i}>
                <span className={`pill ${g.status}`}>{g.status}</span>{" "}
                <strong>{g.name}</strong>
                <div className="meta">{new Date(g.created_at).toLocaleString()}</div>
                {g.summary && <div className="body-text">{g.summary}</div>}
                <details style={{ marginTop: "0.4rem" }}>
                  <summary style={{ cursor: "pointer", fontSize: "0.82rem", color: "var(--ink-soft)" }}>
                    DSSE envelope
                  </summary>
                  <pre className="mono" style={{ overflowX: "auto", fontSize: "0.78rem" }}>
                    {JSON.stringify(g.envelope, null, 2)}
                  </pre>
                </details>
              </div>
            ))
          )}
        </>
      )}
    </>
  );
}
