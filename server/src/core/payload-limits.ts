// #146: a ceiling on what one trajectory event or one checkpoint may carry.
//
// `session_events.payload` and `checkpoints.state` are `z.unknown()` by
// design — ADP never parses them, which is what makes the protocol
// harness-neutral rather than harness-aware. The storage analysis of
// 2026-08-22 measured a mean of 833 B/event across 1,930 real events and noted
// that nothing in the code prevents the ~85 KB/turn the industry anchor
// suggests: a 20× range with no ceiling.
//
// That has been harmless because nothing writes to these tables. The moment
// ambient capture (#149) ships, every connected session is a producer, and the
// first person to enjoy the feature is the first person to fill their own
// disk — which they will report as ADP being unreliable rather than as ADP
// being popular.
//
// **Measuring a size is not reading a value.** The opaqueness invariant holds:
// nothing here inspects the payload's shape, only how many bytes it will
// occupy once stored.
// 128 KiB per event: ~1.5× the industry anchor for a single turn, ~157× the
// mean this schema has actually seen. Deliberately generous — the ceiling
// exists to stop a runaway producer, not to make a well-behaved one think
// about it.
export const MAX_EVENT_PAYLOAD_BYTES = 128 * 1024;

// 1 MiB per batch. A full 1000-event batch at the measured mean is ~833 KB, so
// a realistic maximal batch fits and a pathological one does not: the batch
// ceiling is what stops 1000 events each just under the per-event limit.
export const MAX_BATCH_PAYLOAD_BYTES = 1024 * 1024;

// 1 MiB per checkpoint. Checkpoints are the largest single row this schema
// writes — one is a whole harness's resumable state rather than one turn of
// it — so it gets the batch allowance rather than the event one.
export const MAX_CHECKPOINT_STATE_BYTES = 1024 * 1024;

// Fastify's default body limit is 1 MiB, which sits *below* the batch ceiling
// above — so without this an oversized batch would be refused by the transport
// with a bare 413 naming nothing, which is the "discover the limit rather than
// respect it" failure this issue is about. Raised only on the two ingest
// routes, and only far enough that the typed refusal always wins; the
// transport guard stays, an order of magnitude out, for anything absurd.
export const INGEST_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

// What the value costs to store. `undefined` serializes to nothing and `null`
// to four bytes, which is what the column will hold in each case.
export function jsonByteLength(value: unknown): number {
  if (value === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

// The wire shape of a validation failure is a contract (#97, the shared
// `Error` schema): path, message, and a stable code. These are produced
// directly rather than by fabricating a `ZodError` for `validationErrors()` to
// project — the rule being broken is a size, not a schema, and a fake library
// error would be a lie the type system happens not to catch.
//
// `too_big` is Zod's own code for a size violation, reused so a consumer
// already switching on these codes needs no new case.
export interface PayloadLimitIssue {
  path: (string | number)[];
  message: string;
  code: string;
}

function issue(path: (string | number)[], message: string): PayloadLimitIssue {
  return { path, message, code: "too_big" };
}

export interface PayloadLimitFailure {
  ok: false;
  errors: PayloadLimitIssue[];
}

/**
 * Both ceilings, in one pass over the batch.
 *
 * The batch is checked as a batch and refused as a batch, before anything is
 * chained: `appendEvents` is all-or-nothing by design, and a per-event refusal
 * that let earlier events through would leave a chain the producer cannot
 * reason about.
 */
export function checkEventPayloads(
  events: { payload?: unknown; client_event_id?: string }[],
): { ok: true; totalBytes: number } | PayloadLimitFailure {
  const errors: PayloadLimitIssue[] = [];
  let total = 0;

  events.forEach((event, index) => {
    const bytes = jsonByteLength(event.payload);
    total += bytes;
    if (bytes > MAX_EVENT_PAYLOAD_BYTES) {
      // Named by index *and* by the producer's own id when it set one: an
      // emitter retrying a batch identifies its events by client_event_id, not
      // by position, and a refusal it cannot map back to an event is one it
      // cannot act on.
      const named = event.client_event_id ? ` (client_event_id ${event.client_event_id})` : "";
      errors.push(
        issue(
          ["events", index, "payload"],
          `payload is ${bytes} bytes${named}; the limit is ${MAX_EVENT_PAYLOAD_BYTES} bytes per event`,
        ),
      );
    }
  });

  if (total > MAX_BATCH_PAYLOAD_BYTES) {
    errors.push(
      issue(
        ["events"],
        `batch payloads total ${total} bytes across ${events.length} events; ` +
          `the limit is ${MAX_BATCH_PAYLOAD_BYTES} bytes per batch. Split the batch and retry.`,
      ),
    );
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, totalBytes: total };
}

export function checkCheckpointState(state: unknown): { ok: true } | PayloadLimitFailure {
  const bytes = jsonByteLength(state);
  if (bytes <= MAX_CHECKPOINT_STATE_BYTES) return { ok: true };
  return {
    ok: false,
    errors: [
      issue(["state"], `state is ${bytes} bytes; the limit is ${MAX_CHECKPOINT_STATE_BYTES} bytes per checkpoint`),
    ],
  };
}
