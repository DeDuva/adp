import { useEffect, useState } from "react";
import { api, ApiError, type Connection, type RunDetail, type RunVerification } from "../api.js";
import { runArm, sessionVerdict, shortSha, verificationBadge } from "../format.js";
import Trajectory from "./Trajectory.js";

export default function RunDetailView({
  conn,
  runId,
  onBack,
  onOpenSession,
  onViewEvidence,
  onOpenIssue,
}: {
  conn: Connection;
  runId: string;
  onBack: () => void;
  onOpenSession: (id: string) => void;
  onViewEvidence: (sha: string) => void;
  onOpenIssue: (number: number) => void;
}) {
  const [run, setRun] = useState<RunDetail | null>(null);
  // Resolved by asking the intent's own issue, which is the only place the
  // number lives. One request, and only when the run is loaded.
  const [intentIssue, setIntentIssue] = useState<number | null>(null);
  const [verification, setVerification] = useState<RunVerification | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRun(null);
    setVerification(null);
    setVerifyError(null);
    setIntentIssue(null);
    api
      .getRun(conn, runId)
      .then(async (r) => {
        setRun(r);
        // The issue that carries this run's intent. Found by looking rather
        // than by holding a second copy of the number on the run: an intent may
        // come from an issue, a task or the API, and only the first has one.
        const issues = await api.listIssues(conn).catch(() => []);
        setIntentIssue(issues.find((i) => i.intent_id === r.intent_id)?.number ?? null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
    // Separate request, and a separate failure: verification is the expensive
    // half and the run is still worth reading if it cannot be computed. Since
    // #152 it costs a constant rather than the size of the run, which is what
    // makes it affordable to run on every visit to this page.
    api
      .verifyRun(conn, runId)
      .then(setVerification)
      .catch((err) => setVerifyError(err instanceof ApiError ? err.message : String(err)));
  }, [conn, runId]);

  return (
    <>
      <button className="back" onClick={onBack}>
        ← Runs
      </button>
      {error && <div className="error-banner">{error}</div>}
      {!run ? (
        <div className="empty">Loading…</div>
      ) : (
        <>
          <h1>{runArm(run.labels)}</h1>
          <div className="meta">
            <span className={`pill ${run.status === "closed" ? "merged" : run.status === "abandoned" ? "closed" : "open"}`}>
              {run.status}
            </span>{" "}
            <span className="mono">{run.orchestrator}</span>
            {run.external_ref && (
              <>
                {" "}
                · <span className="mono">{run.external_ref}</span>
              </>
            )}{" "}
            · opened {new Date(run.created_at).toLocaleString()}
            {run.closed_at && <> · closed {new Date(run.closed_at).toLocaleString()}</>}
          </div>

          <div className="meta">
            {/* #157: an intent is reachable through the issue that carries it,
                which is the thing a person can read. The uuid stays visible
                because it is what the API is keyed by, and someone comparing a
                run to a trajectory needs it. */}
            for{" "}
            {intentIssue !== null ? (
              <button className="linkish" onClick={() => onOpenIssue(intentIssue)}>
                #{intentIssue}
              </button>
            ) : (
              "an intent with no issue"
            )}{" "}
            <span className="mono">{run.intent_id}</span>
            {run.final_git_sha && (
              <>
                {" "}
                · landed{" "}
                <button className="linkish mono" onClick={() => onViewEvidence(run.final_git_sha!)}>
                  {shortSha(run.final_git_sha, 10)}
                </button>
              </>
            )}
          </div>

          <Verification verification={verification} error={verifyError} />

          <h2>Sessions</h2>
          <div className="meta">
            One per agent. A session that was resumed under a different harness links back to the one it came
            from — open it to see the whole chain.
          </div>
          <table className="grid">
            <thead>
              <tr>
                <th>Harness</th>
                <th>Status</th>
                <th className="num">Events</th>
                <th>Chain head</th>
                <th>Verified</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {run.sessions.map((s) => {
                const v = verification?.sessions.find((x) => x.session_id === s.id);
                return (
                  <tr key={s.id} className="clickable" onClick={() => onOpenSession(s.id)}>
                    <td>
                      <div>{s.harness}</div>
                      {s.resumed_from_session_id && <div className="meta">resumed</div>}
                    </td>
                    <td>
                      <span className={`pill ${s.status === "closed" ? "merged" : "open"}`}>{s.status}</span>
                    </td>
                    <td className="num mono">{s.event_count}</td>
                    <td className="mono">{shortSha(s.chain_head, 10)}</td>
                    <td className={v && !v.ok ? "bad" : "meta"}>{v ? sessionVerdict(v) : "—"}</td>
                    <td className="meta">{new Date(s.created_at).toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {run.evals.length > 0 && (
            <>
              <h2>Evals</h2>
              <div className="meta">
                An eval <em>is</em> a gate result — same signing, same table, same land policy. Who scored the run
                is part of the record, and whether that was somebody other than whoever ran it.
              </div>
              <table className="grid">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="num">Score</th>
                    <th>Passed</th>
                    <th>Reported by</th>
                    <th>Independent</th>
                  </tr>
                </thead>
                <tbody>
                  {run.evals.map((e) => (
                    <tr key={e.id}>
                      <td className="mono">{e.name}</td>
                      <td className="num mono">{e.score ?? "—"}</td>
                      <td>{e.passed === null ? "—" : <span className={`pill ${e.passed ? "merged" : "closed"}`}>{e.passed ? "pass" : "fail"}</span>}</td>
                      <td className="mono meta">{e.reporter_principal}</td>
                      {/* #121's question, one surface over: a score the author
                          of the run reported is a different kind of evidence
                          from one somebody else did. */}
                      <td className={e.separately_authorized ? "" : "meta"}>
                        {e.separately_authorized ? "yes" : "same principal"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {/* #157: run → its commits, each one a step back into the evidence
              the other direction of this edge starts from. `final_git_sha` is
              what the run attested; these are everything its sessions actually
              committed on the way, which is not the same list. */}
          {run.commits.length > 0 && (
            <>
              <h2>Commits</h2>
              <div className="meta">
                Recorded as commit events in the trajectory. Open one for its signed change, its provenance and
                every gate reported against it.
              </div>
              <div className="commit-list">
                {run.commits.map((sha) => (
                  <button key={sha} className="linkish mono" onClick={() => onViewEvidence(sha)}>
                    {shortSha(sha, 10)}
                  </button>
                ))}
              </div>
            </>
          )}

          <Trajectory conn={conn} runId={runId} onOpenSession={onOpenSession} />
        </>
      )}
    </>
  );
}

// #156 is explicit that the two answers stay apart. `chains_ok` says the events
// ADP holds were not edited; `emitters_ok` says ADP was given all of them. A run
// can pass the first and fail the second, and that combination — a chain that
// verifies perfectly while events the emitter numbered never arrived — is the
// more interesting half. One green tick would throw it away.
function Verification({ verification, error }: { verification: RunVerification | null; error: string | null }) {
  if (error) {
    return (
      <div className="card">
        <h2>Verification</h2>
        <div className="error-banner">{error}</div>
      </div>
    );
  }
  if (!verification) return <div className="card">Verifying…</div>;

  const badge = verificationBadge(verification);
  return (
    <div className={`card verification ${badge.tone}`}>
      <h2>Verification</h2>
      <div className="checks">
        <Check tone={badge.chains.tone} title="Chain" label={badge.chains.label} />
        <Check tone={badge.emitters.tone} title="Completeness" label={badge.emitters.label} />
        <Check tone={badge.attestation.tone} title="Attestation" label={badge.attestation.label} />
      </div>
      {badge.partial && <div className="note-banner">{badge.partial}</div>}
      <div className="meta mono">
        recomputed {shortSha(verification.recomputed_trajectory_digest, 16)}
        {verification.attested_trajectory_digest && (
          <> · attested {shortSha(verification.attested_trajectory_digest, 16)}</>
        )}
      </div>
      <div className="meta">
        Recomputed from the stored rows by this request. Tamper-evidence nobody can check is decoration — anyone
        holding a read token can run this and get the same answer.
      </div>
    </div>
  );
}

function Check({ tone, title, label }: { tone: string; title: string; label: string }) {
  return (
    <div className={`check ${tone}`}>
      <div className="check-title">{title}</div>
      <div className="check-label">{label}</div>
    </div>
  );
}
