import { useEffect, useState } from "react";
import { api, type Connection, type EvidenceBundle, ApiError } from "../api.js";
import { runArm } from "../format.js";

// #157. `getEvidenceBundle` has returned the change with its `intent_id` since
// M1, and the intent's title since #189 — and this view rendered neither. That
// is the exact point at which JTBD-2 ("when a change lands wrong, I want to know
// what the agent was trying to do") was one click from being answered and was
// not: the reader is holding the identifier of the thing they want and has no
// way to follow it.
export default function EvidenceView({
  conn,
  sha,
  onBack,
  onOpenIssue,
  onOpenRun,
  onOpenSession,
  onOpenProposal,
}: {
  conn: Connection;
  sha: string;
  onBack: () => void;
  onOpenIssue: (number: number) => void;
  onOpenRun: (id: string) => void;
  onOpenSession: (id: string) => void;
  onOpenProposal: (number: number) => void;
}) {
  const [bundle, setBundle] = useState<EvidenceBundle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBundle(null);
    api
      .getEvidence(conn, sha)
      .then(setBundle)
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, [conn, sha]);

  const produced = bundle?.produced_by;
  const hasEdges =
    produced &&
    (produced.sessions.length > 0 ||
      produced.runs.length > 0 ||
      produced.proposals.length > 0 ||
      produced.models.source !== "none");

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

          {/* The intent leads, because "what was this for" is the question an
              evidence bundle is opened to answer. An unbound change says so
              rather than showing a blank: a commit pushed with no trailer and
              never bound afterwards is an ordinary state, not a fault. */}
          {bundle.change?.intent ? (
            <div className="meta">
              for{" "}
              {bundle.change.intent.issue_number !== null ? (
                <button className="linkish" onClick={() => onOpenIssue(bundle.change!.intent!.issue_number!)}>
                  #{bundle.change.intent.issue_number} {bundle.change.intent.title}
                </button>
              ) : (
                <strong>{bundle.change.intent.title}</strong>
              )}
            </div>
          ) : (
            <div className="meta">
              This commit is bound to no intent — it was pushed without an <code>ADP-Intent</code> trailer and
              never bound afterwards.
            </div>
          )}

          {hasEdges && (
            <div className="card">
              <h3>Produced by</h3>
              <div className="meta">
                Joins over what is already recorded, not part of what is signed — a commit event carries its
                <code> git_sha</code> as a typed column precisely so this needs no payload parsing.
              </div>
              {/* #231: which model produced this, and whether that is an
                  observation or a claim. `provenance.model` is what the token
                  asserted once at connect time; the trajectory records the
                  model per event, and a harness can change it inside a run.
                  Showing the weaker fact is fine — showing it as though it
                  were the stronger one is not, which is why the label is here
                  rather than only the value. */}
              {produced!.models.source !== "none" && (
                <div className="edge">
                  <span className="edge-label">Model</span>
                  <div>
                    {produced!.models.source === "observed" ? (
                      <>
                        <strong>{produced!.models.observed.join(" → ")}</strong>
                        <div className="meta">
                          observed in the trajectory
                          {produced!.models.observed.length > 1 && ", which changed during the run"}
                          {produced!.models.asserted &&
                            !produced!.models.observed.includes(produced!.models.asserted) &&
                            ` — the token asserted ${produced!.models.asserted}`}
                        </div>
                      </>
                    ) : (
                      <>
                        <strong>{produced!.models.asserted}</strong>
                        <div className="meta">
                          asserted by the harness at connect time — no trajectory was recorded for this
                          commit, so nothing observed it
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
              {produced!.runs.length > 0 && (
                <div className="edge">
                  <span className="edge-label">Run</span>
                  <div>
                    {produced!.runs.map((r) => (
                      <div key={r.id}>
                        <button className="linkish" onClick={() => onOpenRun(r.id)}>
                          {runArm(r.labels) === "—" ? r.orchestrator : runArm(r.labels)}
                        </button>{" "}
                        <span className="meta">· {r.status}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {produced!.sessions.length > 0 && (
                <div className="edge">
                  <span className="edge-label">Session</span>
                  <div>
                    {produced!.sessions.map((s) => (
                      <div key={s.id}>
                        <button className="linkish" onClick={() => onOpenSession(s.id)}>
                          {s.harness}
                        </button>{" "}
                        <span className="meta mono">· committed at event {s.seq}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {produced!.proposals.length > 0 && (
                <div className="edge">
                  <span className="edge-label">Proposal</span>
                  <div>
                    {produced!.proposals.map((p) => (
                      <div key={p.number}>
                        <button className="linkish" onClick={() => onOpenProposal(p.number)}>
                          #{p.number} {p.title}
                        </button>{" "}
                        <span className="meta">· {p.state}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

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
                <span className={`pill ${g.status}`}>{g.status}</span> <strong>{g.name}</strong>
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
