// The wire shape of a trajectory event, restated rather than imported.
//
// `recorder/` is a pure HTTP client of ADP on the same terms as `runner/` and
// `cli/`: no `server/` import anywhere in this package, no database
// credential, no signing key. That rule costs this one duplication — the kind
// vocabulary below also lives in `server/src/core/trajectory.ts` — and buys
// the thing the duplication is for: this process can be run by someone who
// does not have the server checked out, and a future rewrite of it in another
// language reads the same published contract (`spec/openapi.yaml`) rather than
// this file.
//
// The vocabulary is fixed and the server *does* branch on it, which is exactly
// why mapping a harness's private event names onto it is the recorder's job
// and not the server's. `custom` is the escape hatch that keeps the list from
// having to be complete.

export const EVENT_KINDS = [
  "message",
  "model_call",
  "tool_call",
  "handoff",
  "commit",
  "test_result",
  "custom",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_STATUSES = ["success", "failure", "error", "rejected", "skipped"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/**
 * One event as the append endpoint takes it — snake_case, because this is the
 * wire and not an internal type.
 *
 * `client_event_id` and `producer_seq` are absent here and added by the spool.
 * They are the recorder's two guarantees rather than the reader's business: an
 * id makes a retried batch idempotent, and a contiguous counter makes a
 * genuinely dropped event *detectable* rather than assumed absent. A reader
 * that had to set them would be a reader that could get them wrong.
 */
export interface TrajectoryEvent {
  kind: EventKind;
  type?: string;
  payload?: unknown;
  status?: EventStatus;
  model?: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_micro_usd?: number;
  duration_ms?: number;
  git_sha?: string;
  related_session_id?: string;
  occurred_at?: string;
}

/** A spooled event: what the reader produced, plus the recorder's guarantees. */
export interface SpooledEvent extends TrajectoryEvent {
  client_event_id: string;
  producer_seq: number;
}

/**
 * Keep a reader's output inside the vocabulary, whoever wrote the reader.
 *
 * `kind` is a stored enum the server *does* branch on, and an event outside it
 * is a 422 at ingest. A 422 is `refused` to the shipper, and refused
 * quarantines the session — deliberately, because a rejected batch that got
 * discarded to keep moving would manufacture exactly the gap the spool exists
 * to prevent. The consequence is that **one malformed event costs the whole
 * session**, and that is an acceptable price for a bug in this repository and
 * an unacceptable one for a typo in a third-party reader (`readers/index.ts`).
 *
 * So the boundary is checked here rather than trusted. A bad event is not
 * dropped and not silently repaired: it is relabelled `custom`, its rejected
 * values are named in `type` where they cost no payload budget, and everything
 * else about it — the payload, the token counts, the timing — arrives intact.
 * The record then says a reader emitted something outside the vocabulary,
 * which is a fact worth having and the only way anyone finds out.
 */
export function normalizeEvent(event: TrajectoryEvent): TrajectoryEvent {
  const kindOk = (EVENT_KINDS as readonly string[]).includes(event.kind);
  const statusOk = event.status === undefined || (EVENT_STATUSES as readonly string[]).includes(event.status);
  if (kindOk && statusOk) return event;

  // Truncated, because `type` is unbounded text on the wire and a reader
  // emitting a kind built from user input would otherwise write it all down.
  const show = (value: unknown) => String(value).slice(0, 64);
  const rejected = [
    ...(kindOk ? [] : [`kind=${show(event.kind)}`]),
    ...(statusOk ? [] : [`status=${show(event.status)}`]),
  ].join(",");

  return {
    ...event,
    kind: kindOk ? event.kind : "custom",
    status: statusOk ? event.status : undefined,
    type: `recorder.invalid_event(${rejected})${event.type ? ` ${event.type}` : ""}`,
  };
}
