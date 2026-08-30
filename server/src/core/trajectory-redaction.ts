// #148: secret detection at the trajectory ingest path.
//
// ADP already runs push protection at the wire — `pre-receive` computes the
// diff, ships the text, and a regex-plus-entropy engine refuses the push
// naming the line and pattern. That is the only in-tree detector by design,
// and it is well placed for what it guards: **the diff**.
//
// A trajectory is a different object. It records what the agent *read* — file
// contents pulled into context, environment inspected, tool output returned,
// prompts a human typed. A `.env` the agent opened and correctly decided not
// to commit never appears in any diff and would appear verbatim in a
// `tool_call` payload. Push protection cannot see it, because it was never
// pushed. Ambient capture (#149) makes that the default behaviour of every
// connected session, and the failure mode is durable, hash-chained, and
// readable by anyone holding a `repo:read` token.
//
// **What this costs, stated plainly.** #146 kept the opaqueness invariant by
// noting that measuring a size is not reading a value. This does read the
// value; there is no way to detect a secret without looking at one. What is
// preserved is the half that makes the protocol harness-neutral: nothing here
// branches on the payload's *shape*. It walks to the string leaves of an
// arbitrary JSON value and scans each one, so a harness storing its own format
// still needs no ADP change — the walker does not know or care what the format
// means.
import { redactText } from "./secret-scan.js";

/** Where a redaction happened, and what fired. Stored beside the event. */
export interface Redaction {
  /** A JSON path into the payload, e.g. `$.tool_output` or `$.messages[2].text`. */
  path: string;
  pattern: string;
}

export interface RedactionResult<T> {
  value: T;
  redactions: Redaction[];
}

// Object keys are deliberately not scanned or rewritten. A key is structure,
// and rewriting one would change the shape of a payload ADP promises not to
// interpret — the redaction would be indistinguishable from the harness having
// written a different document.
function walk(value: unknown, path: string, redactions: Redaction[]): unknown {
  if (typeof value === "string") {
    const { text, patterns } = redactText(value);
    for (const pattern of patterns) redactions.push({ path, pattern });
    return text;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => walk(entry, `${path}[${index}]`, redactions));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = walk(entry, `${path}.${key}`, redactions);
    }
    return out;
  }
  // Numbers, booleans and null cannot carry a secret the engine recognises,
  // and round-trip unchanged.
  return value;
}

export function redactPayload(payload: unknown): RedactionResult<unknown> {
  const redactions: Redaction[] = [];
  const value = walk(payload, "$", redactions);
  return { value, redactions };
}

/**
 * The whole batch, redacted, with every redaction located by event index as
 * well as by path.
 *
 * Done before anything is chained, so what gets hashed is what gets stored —
 * the redaction is covered by the chain rather than applied to a record that
 * already vouched for the original.
 */
export function redactEventPayloads<T extends { payload?: unknown }>(
  events: T[],
): { events: T[]; redactions: (Redaction & { index: number })[] } {
  const all: (Redaction & { index: number })[] = [];
  const redacted = events.map((event, index) => {
    if (event.payload === undefined || event.payload === null) return event;
    const { value, redactions } = redactPayload(event.payload);
    if (redactions.length === 0) return event;
    for (const redaction of redactions) all.push({ ...redaction, index });
    return { ...event, payload: value };
  });
  return { events: redacted, redactions: all };
}
