import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  EVENT_KINDS,
  type Connection,
  type EventKind,
  type TrajectoryEvent,
  type TrajectoryPage,
} from "../api.js";
import { formatCost, formatDuration, formatTokens, payloadIsProjected, payloadPreview, shortSha } from "../format.js";

const PAGE = 100;

// The trajectory, rendered as the typed record it is rather than as a column of
// JSON. Every one of these columns is covered by the hash chain — that is why
// they exist beside `payload` at all — so showing them is showing the thing the
// signature vouches for.
//
// Paged rather than loaded: #156 asks that a long trajectory paginate without
// pulling the run into the browser, which is the same property #152 gave the
// server side. `total` comes back with every page, so the control below can say
// where you are without a second request.
export default function Trajectory({
  conn,
  runId,
  onOpenSession,
}: {
  conn: Connection;
  runId: string;
  onOpenSession: (id: string) => void;
}) {
  const [page, setPage] = useState<TrajectoryPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [kinds, setKinds] = useState<EventKind[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setPage(null);
    api
      .getTrajectory(conn, runId, { kinds, limit: PAGE, offset })
      .then((p) => live && setPage(p))
      .catch((err) => live && setError(err instanceof ApiError ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [conn, runId, kinds, offset]);

  function toggleKind(kind: EventKind) {
    setOffset(0);
    setKinds((current) => (current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind]));
  }

  const total = page?.total ?? 0;
  const shown = page?.events.length ?? 0;

  return (
    <>
      <h2>Trajectory</h2>
      <div className="filters">
        {EVENT_KINDS.map((kind) => (
          <button
            key={kind}
            className={`chip ${kinds.includes(kind) ? "on" : ""}`}
            onClick={() => toggleKind(kind)}
            aria-pressed={kinds.includes(kind)}
          >
            {kind}
          </button>
        ))}
        {kinds.length > 0 && (
          <button
            className="chip clear"
            onClick={() => {
              setKinds([]);
              setOffset(0);
            }}
          >
            clear
          </button>
        )}
      </div>

      {/* Said once, at the top, rather than repeated on every row. #199 stores
          payloads as structure by default — the shape survives and the strings
          do not — which is the single most important thing to know before
          reading this table, because it is why the "what" column shows a shape
          where a reader expects a sentence. The remedy is one line of the
          repo's own adp.yaml, so it is named. */}
      {page && page.events.some(payloadIsProjected) && (
        <div className="note-banner">
          Payloads are stored as <strong>structure</strong> in this repository: keys, numbers and shape are kept,
          and every string was replaced by its byte count before the event was chained. What the agent{" "}
          <em>did</em> — the tool, the verdict, the tokens, the cost, the commit — is all here; what it{" "}
          <em>said</em> is not retained. Set <code>trajectory.payloads: full</code> in <code>adp.yaml</code> to
          store payloads as supplied.
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}
      {!page ? (
        <div className="empty">Loading…</div>
      ) : page.events.length === 0 ? (
        <div className="empty">
          {kinds.length > 0 ? "No events of these kinds." : "This run recorded no events."}
        </div>
      ) : (
        <>
          <table className="grid trajectory">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Kind</th>
                <th>What</th>
                <th>Status</th>
                <th>Model</th>
                <th className="num">Tokens</th>
                <th className="num">Cost</th>
                <th className="num">Took</th>
                <th>Commit</th>
              </tr>
            </thead>
            <tbody>
              {page.events.map((e) => (
                <EventRow
                  key={e.id}
                  event={e}
                  expanded={expanded === e.id}
                  onToggle={() => setExpanded(expanded === e.id ? null : e.id)}
                  onOpenSession={onOpenSession}
                />
              ))}
            </tbody>
          </table>
          <div className="pager">
            <button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              ← newer
            </button>
            <span className="meta mono">
              {offset + 1}–{offset + shown} of {total}
            </span>
            <button className="btn" disabled={offset + shown >= total} onClick={() => setOffset(offset + PAGE)}>
              older →
            </button>
          </div>
        </>
      )}
    </>
  );
}

function EventRow({
  event,
  expanded,
  onToggle,
  onOpenSession,
}: {
  event: TrajectoryEvent;
  expanded: boolean;
  onToggle: () => void;
  onOpenSession: (id: string) => void;
}) {
  const failed = event.status === "failure" || event.status === "error";
  const tokens = event.tokens_in !== null || event.tokens_out !== null ? (event.tokens_in ?? 0) + (event.tokens_out ?? 0) : null;

  return (
    <>
      <tr className={`clickable ${failed ? "row-bad" : ""}`} onClick={onToggle}>
        <td className="num mono">{event.seq}</td>
        <td>
          <span className="kind">{event.kind}</span>
        </td>
        <td>
          <div className="what">
            <span className="mono">{event.type}</span> <span className="meta">{payloadPreview(event)}</span>
          </div>
          {/* #148: an event nothing fired on carries no `redactions` at all, so
              this appears exactly where a secret was actually found — which is
              the difference between "the agent never saw one" and "the agent saw
              one and this is what is left of it". */}
          {event.redactions && event.redactions.length > 0 && (
            <div className="meta bad">
              {event.redactions.length} redacted: {event.redactions.map((r) => r.pattern).join(", ")}
            </div>
          )}
        </td>
        <td>{event.status ? <span className={`pill ${failed ? "closed" : "open"}`}>{event.status}</span> : "—"}</td>
        <td className="mono meta">{event.model ?? "—"}</td>
        <td className="num mono">{formatTokens(tokens)}</td>
        <td className="num mono">{formatCost(event.cost_micro_usd)}</td>
        <td className="num mono">{formatDuration(event.duration_ms)}</td>
        <td className="mono">{shortSha(event.git_sha)}</td>
      </tr>
      {expanded && (
        <tr className="detail-row">
          <td colSpan={9}>
            <div className="event-detail">
              <div className="meta">
                session{" "}
                <button className="linkish mono" onClick={() => onOpenSession(event.session_id)}>
                  {event.session_id.slice(0, 8)}
                </button>{" "}
                · {new Date(event.occurred_at).toLocaleString()}
                {event.producer_seq !== null && <> · producer #{event.producer_seq}</>}
                {event.producer_id && <> · {event.producer_id}</>}
              </div>
              {/* #199: under the default policy the payload stored is the
                  *structure* of what was sent — objects, arrays, keys, numbers
                  kept; every string replaced by its byte count. Saying so is
                  the difference between "this is all there was" and "this is
                  what is left of it", and the digest is what a producer holding
                  its own copy proves the correspondence against. */}
              {payloadIsProjected(event) && (
                <div className="note-banner">
                  Stored as structure, not content — strings were replaced by their byte counts before this was
                  chained. <span className="mono">payload_digest {shortSha(event.payload_digest, 12)}</span> covers
                  what was sent.
                </div>
              )}
              <pre className="payload">{JSON.stringify(event.payload, null, 2)}</pre>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
