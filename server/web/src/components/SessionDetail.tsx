import { useEffect, useState } from "react";
import { api, ApiError, type Connection, type SessionDetail, type VerifySession } from "../api.js";
import { sessionVerdict, shortSha } from "../format.js";

// D2, the capability that most distinguishes ADP from a forge with signed
// commits: one continuous signed history across harnesses. `resumed_from_session_id`
// is self-referencing, so a chain of resumes across three harnesses is walkable
// without a join table — and #156 asks that it be a picture rather than a series
// of API calls. The server returns the whole lineage with the session, oldest
// first, so this is one request.
export default function SessionDetailView({
  conn,
  sessionId,
  onBack,
  onOpenSession,
  onViewEvidence,
}: {
  conn: Connection;
  sessionId: string;
  onBack: () => void;
  onOpenSession: (id: string) => void;
  onViewEvidence: (sha: string) => void;
}) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [verification, setVerification] = useState<VerifySession | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSession(null);
    setVerification(null);
    api
      .getSession(conn, sessionId)
      .then(setSession)
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
    // #152's session-scoped endpoint. A session need not belong to a run — a
    // developer checkpointing their own work is a session — so this is the only
    // way some of them can be verified at all.
    api
      .verifySession(conn, sessionId)
      .then(setVerification)
      .catch(() => setVerification(null));
  }, [conn, sessionId]);

  return (
    <>
      <button className="back" onClick={onBack}>
        ← Back
      </button>
      {error && <div className="error-banner">{error}</div>}
      {!session ? (
        <div className="empty">Loading…</div>
      ) : (
        <>
          <h1>{session.harness}</h1>
          <div className="meta">
            <span className={`pill ${session.status === "closed" ? "merged" : "open"}`}>{session.status}</span>{" "}
            <span className="mono">{session.id}</span> · started{" "}
            {new Date(session.created_at).toLocaleString()}
          </div>
          {verification && (
            <div className={`card verification ${verification.ok ? "ok" : "bad"}`}>
              <div className="check-title">Chain</div>
              <div className="check-label">{sessionVerdict(verification)}</div>
              {verification.anchor && (
                <div className="meta">
                  Verified from checkpoint {verification.anchor.checkpoint_seq}, whose signature covers the first{" "}
                  {verification.anchor.event_count} events. Everything before that point is attested rather than
                  rehashed.
                </div>
              )}
            </div>
          )}

          <h2>Lineage</h2>
          <div className="meta">
            {session.lineage.length === 1
              ? "This session started the work — nothing was resumed into it."
              : `${session.lineage.length} sessions, one continuous signed history. Each resume verified the checkpoint's signature before forking a workspace at its commit.`}
          </div>
          <ol className="lineage">
            {session.lineage.map((s, i) => (
              <li key={s.id} className={s.id === session.id ? "current" : ""}>
                <div className="lineage-harness">{s.harness}</div>
                <div className="meta mono">
                  <button className="linkish mono" onClick={() => onOpenSession(s.id)} disabled={s.id === session.id}>
                    {s.id.slice(0, 8)}
                  </button>{" "}
                  · {s.status} · {new Date(s.created_at).toLocaleString()}
                </div>
                {i < session.lineage.length - 1 && <div className="lineage-arrow">resumed as ↓</div>}
              </li>
            ))}
          </ol>

          <h2>Checkpoints</h2>
          {session.checkpoints.length === 0 ? (
            <div className="empty">
              No checkpoints. A checkpoint signs the commit and the chain head it reached, which is what makes a
              session resumable in another harness.
            </div>
          ) : (
            <table className="grid">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Harness</th>
                  <th>Commit</th>
                  <th>Taken</th>
                </tr>
              </thead>
              <tbody>
                {session.checkpoints.map((c) => (
                  <tr key={c.id}>
                    <td className="num mono">{c.seq}</td>
                    <td>{c.harness}</td>
                    <td>
                      <button className="linkish mono" onClick={() => onViewEvidence(c.git_sha)}>
                        {shortSha(c.git_sha, 10)}
                      </button>
                    </td>
                    <td className="meta">{new Date(c.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}
