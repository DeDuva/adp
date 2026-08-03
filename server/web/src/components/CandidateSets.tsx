import { useEffect, useState } from "react";
import { api, ApiError, type Candidate, type CandidateSetDetail, type CandidateSetSummary, type Connection } from "../api.js";

// M3 / D1 (docs/adp-prototype-implementation-plan.md §5): "The money shot is the
// history view: one landed change, intent attached, 49 discarded attempts
// queryable but not polluting history."
//
// That sentence is the whole design brief for this view, and the second half of
// it is the part worth getting right: the losers must be *visible*, alongside
// the evidence that decided against them. A view that showed only the winner
// would make a 50-way fan-out indistinguishable from a single proposal, which
// is exactly the thing GitHub cannot express and this is meant to demonstrate.

export function CandidateSetList({ conn, onOpen }: { conn: Connection; onOpen: (id: string) => void }) {
  const [sets, setSets] = useState<CandidateSetSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listCandidateSets(conn)
      .then(setSets)
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, [conn]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!sets) return <div className="empty">Loading…</div>;

  return (
    <>
      <h1>Candidate sets</h1>
      {sets.length === 0 ? (
        <div className="empty">
          No candidate sets yet. A set is opened against an intent, and proposals join it by passing{" "}
          <code>candidate_set_id</code> when they are created.
        </div>
      ) : (
        <div className="list">
          {sets.map((s) => (
            <button key={s.id} className="list-row" onClick={() => onOpen(s.id)}>
              <span className="num">{s.candidate_count}×</span>
              <span className="title">{s.selection_policy}</span>
              <span className="mono meta" style={{ marginBottom: 0 }}>
                {new Date(s.created_at).toLocaleString()}
              </span>
              <span className={`pill ${s.status === "resolved" ? "merged" : "open"}`}>{s.status}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function scoreLabel(candidate: Candidate) {
  // "not measured" rather than "0" — a candidate with no score gate was never
  // ranked, which is a different claim from ranking at the bottom.
  return candidate.score === null ? "—" : String(candidate.score);
}

export function CandidateSetDetailView({
  conn,
  id,
  onBack,
  onViewEvidence,
}: {
  conn: Connection;
  id: string;
  onBack: () => void;
  onViewEvidence: (sha: string) => void;
}) {
  const [set, setSet] = useState<CandidateSetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getCandidateSet(conn, id)
      .then(setSet)
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, [conn, id]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!set) return <div className="empty">Loading…</div>;

  const winner = set.candidates.find((c) => c.id === set.selected_proposal_id);
  const others = set.candidates.filter((c) => c.id !== set.selected_proposal_id);

  return (
    <>
      <button className="back" onClick={onBack}>
        ← Candidate sets
      </button>

      <h1>
        Candidate set <span className={`pill ${set.status === "resolved" ? "merged" : "open"}`}>{set.status}</span>
      </h1>
      <p className="meta mono">
        policy {set.selection_policy} · intent {set.intent_id} · {set.candidates.length} candidates
        {set.resolved_at ? ` · resolved ${new Date(set.resolved_at).toLocaleString()}` : ""}
      </p>

      <h2>Landed</h2>
      {winner ? (
        <CandidateRow candidate={winner} winner onViewEvidence={onViewEvidence} />
      ) : (
        <div className="empty">
          Nothing landed yet. {set.selection_policy === "manual"
            ? "This set uses the manual policy, so a candidate has to be selected before it can resolve."
            : "The set resolves when a candidate satisfies its selection policy and land policy."}
        </div>
      )}

      <h2>Not selected ({others.length})</h2>
      {others.length === 0 ? (
        <div className="empty">No other candidates.</div>
      ) : (
        <div className="list">
          {others.map((c) => (
            <CandidateRow key={c.id} candidate={c} onViewEvidence={onViewEvidence} />
          ))}
        </div>
      )}
      <p className="meta">
        Reclaimed candidates keep their proposal and their evidence — only their workspace branch is
        deleted. The attempts stay queryable without landing in the history.
      </p>
    </>
  );
}

function CandidateRow({
  candidate,
  winner = false,
  onViewEvidence,
}: {
  candidate: Candidate;
  winner?: boolean;
  onViewEvidence: (sha: string) => void;
}) {
  return (
    <div className={`list-row${winner ? " winner" : ""}`} style={{ cursor: "default" }}>
      <span className="num">#{candidate.number}</span>
      <span className="title">{candidate.title}</span>
      <span className="mono meta" style={{ marginBottom: 0 }}>
        score {scoreLabel(candidate)}
      </span>
      <span className="mono meta" style={{ marginBottom: 0 }}>
        {candidate.gates.length === 0
          ? "no gates"
          : candidate.gates.map((g) => `${g.name}:${g.status}`).join(" ")}
      </span>
      <span className={`pill ${candidate.state}`}>{candidate.state}</span>
      <button className="back" style={{ margin: 0 }} onClick={() => onViewEvidence(candidate.head_sha)}>
        Evidence
      </button>
    </div>
  );
}
