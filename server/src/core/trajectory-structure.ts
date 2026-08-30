// #199: what a trajectory stores when nothing is detected at all.
//
// #148 put the secret detector at this ingest path, and that is a real
// reduction in blast radius — but it removes what a *detector recognises*.
// This governs the larger surface: source no pattern covers, customer data in
// a tool result, a prompt a human typed. Ambient capture (#149) makes every
// connected session a producer of it, by default, without anyone asking.
//
// **Structure by default; full payloads opt-in per repository.** The asymmetry
// is the whole argument. An adopter can widen `trajectory.payloads` to `full`
// after reading what a trajectory holds, and cannot unsend what already
// arrived. Deciding it before #149 ships makes the flip free, because nothing
// writes to these tables yet; deciding it afterwards would be a migration and
// an apology, taken against exactly the early adopters whose first trajectories
// were recorded under the wrong default.
//
// **What survives is not a stub.** The typed columns are untouched — kind,
// type, status, model, token counts, duration, git sha, the handoff edge — and
// they are where "what did the agent do" is actually answered: `type` already
// carries the tool name, `status` the outcome, `git_sha` the commit. What this
// removes is the string *content* of the payload, keeping the payload's shape:
// its objects, its arrays, its keys, its numbers and booleans, and how long
// each string was. A reader sees that a `read_file` returned a 14 KB body from
// `$.output`; they do not see the body.
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import { mapStringLeaves } from "./json-leaves.js";

/**
 * What replaces a string leaf.
 *
 * Length in **UTF-8 bytes**, named in the marker rather than left to be
 * guessed: bytes are the unit #146's ceilings already speak, and a byte count
 * is reproducible by a verifier that is not JavaScript, which a count of
 * UTF-16 code units is not.
 */
export function structureMarker(text: string): string {
  return `[adp:str bytes=${Buffer.byteLength(text, "utf8")}]`;
}

export interface StructuredPayload {
  /** The payload with every string leaf replaced by its marker. */
  value: unknown;
  /**
   * sha256, hex, over the canonical JSON of the payload **as supplied** —
   * which is what `full` would have stored, and therefore what a producer
   * holding its own copy can check against.
   *
   * One digest over the whole payload rather than one per string leaf, and
   * that is a size decision taken deliberately. A per-leaf sha256 costs ~89
   * bytes in place of each string, so a payload of a few hundred short strings
   * — a structured tool result, a message array — would come out *larger*
   * structured than whole. A default that inflates the common case is not a
   * default anyone keeps. The commitment is not weakened for what it is for:
   * 3-6's "verified, payload not retained" is an attestation over a payload,
   * and per-leaf verification would need the whole payload in hand to
   * recompute anyway. What is genuinely lost is leaf-level comparison — "this
   * prompt is the one from three events ago" — which nothing asks for yet.
   */
  digest: string;
}

export function structurePayload(payload: unknown): StructuredPayload {
  return {
    value: mapStringLeaves(payload, structureMarker),
    // Canonical, so a key order the harness happened to build in cannot change
    // what the digest commits to — the same reason `eventHash` uses it.
    digest: createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex"),
  };
}

/**
 * The whole batch, projected, with each event's digest by position.
 *
 * `null` where the event carried no payload at all: there is nothing not
 * retained, so claiming a commitment over it would be a digest of the absence
 * of a payload dressed up as evidence about one. It also keeps a payload-less
 * event hashing exactly as it does today.
 *
 * Run **after** #148's redaction and before anything is chained. After,
 * because the digest has to name what `full` would have stored, and under
 * `on_secret: redact` that is the redacted text rather than the secret — a
 * digest committing to the original would be a durable commitment to the
 * secret this path exists to keep out. Before the chain, for the reason
 * redaction is: what gets hashed has to be what gets stored.
 */
export function structureEventPayloads<T extends { payload?: unknown }>(
  events: T[],
): { events: T[]; digests: (string | null)[] } {
  const digests: (string | null)[] = [];
  const structured = events.map((event) => {
    if (event.payload === undefined || event.payload === null) {
      digests.push(null);
      return event;
    }
    const { value, digest } = structurePayload(event.payload);
    digests.push(digest);
    return { ...event, payload: value };
  });
  return { events: structured, digests };
}
