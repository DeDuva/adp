import { useEffect, useState } from "react";
import { api, type Connection, type Operation, ApiError } from "../api.js";

// The one control this read-only UI grants: humans supervise, agents act —
// except undo, the safety-critical exception (docs/pragmatic_mvp.md §2.2,
// "op log with undo"). Everything else here is display-only.
export default function OperationsLog({ conn, onViewEvidence }: { conn: Connection; onViewEvidence: (sha: string) => void }) {
  const [ops, setOps] = useState<Operation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verbFilter, setVerbFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [undoing, setUndoing] = useState<string | null>(null);
  const [undoResult, setUndoResult] = useState<Record<string, string>>({});

  function load() {
    setOps(null);
    api
      .listOperations(conn, { verb: verbFilter || undefined, actor: actorFilter || undefined, limit: "100" })
      .then(setOps)
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }

  useEffect(load, [conn, verbFilter, actorFilter]);

  const undoneParents = new Set((ops ?? []).filter((o) => o.parent_op).map((o) => o.parent_op!));

  async function undo(op: Operation) {
    setUndoing(op.id);
    try {
      await api.undoOperation(conn, op.id);
      setUndoResult((r) => ({ ...r, [op.id]: "Undone." }));
      load();
    } catch (err) {
      setUndoResult((r) => ({ ...r, [op.id]: err instanceof ApiError ? err.message : String(err) }));
    } finally {
      setUndoing(null);
    }
  }

  return (
    <>
      <h1>Operation log</h1>
      <div className="filters">
        <select value={verbFilter} onChange={(e) => setVerbFilter(e.target.value)}>
          <option value="">All verbs</option>
          <option value="proposal.merge">proposal.merge</option>
          <option value="proposal.merge.undo">proposal.merge.undo</option>
          <option value="change.create">change.create</option>
          <option value="issue.create">issue.create</option>
          <option value="review.create">review.create</option>
          <option value="gate.report">gate.report</option>
          <option value="workspace.create">workspace.create</option>
          <option value="workspace.destroy">workspace.destroy</option>
        </select>
        <input placeholder="actor id (uuid)" value={actorFilter} onChange={(e) => setActorFilter(e.target.value)} />
      </div>

      {error && <div className="error-banner">{error}</div>}
      {!ops ? (
        <div className="empty">Loading…</div>
      ) : ops.length === 0 ? (
        <div className="empty">No matching operations.</div>
      ) : (
        <div className="list">
          {ops.map((op) => {
            const isMerge = op.verb === "proposal.merge";
            const alreadyUndone = undoneParents.has(op.id);
            const sha = op.target.includes("@") ? op.target.split("@")[1] : null;
            return (
              <div className="list-row" key={op.id} style={{ cursor: "default", flexWrap: "wrap" }}>
                <span className="mono" style={{ fontSize: "0.78rem", flex: "none", width: "9rem" }}>
                  {new Date(op.created_at).toLocaleString()}
                </span>
                <span className="mono" style={{ flex: "none", width: "11rem" }}>
                  {op.verb}
                </span>
                <span className="op-target title">{op.target}</span>
                {sha && (
                  <button className="btn" onClick={() => onViewEvidence(sha)}>
                    Evidence
                  </button>
                )}
                {isMerge && (
                  <button className="btn danger" disabled={alreadyUndone || undoing === op.id} onClick={() => undo(op)}>
                    {alreadyUndone ? "Undone" : undoing === op.id ? "Undoing…" : "Undo"}
                  </button>
                )}
                {undoResult[op.id] && <div style={{ width: "100%", fontSize: "0.8rem", color: "var(--ink-soft)" }}>{undoResult[op.id]}</div>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
