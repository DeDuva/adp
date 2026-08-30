import { describe, it, expect } from "vitest";
import {
  MAX_BATCH_PAYLOAD_BYTES,
  MAX_CHECKPOINT_STATE_BYTES,
  MAX_EVENT_PAYLOAD_BYTES,
  checkCheckpointState,
  checkEventPayloads,
  jsonByteLength,
} from "./payload-limits.js";

// A payload of roughly `bytes` once serialized. The quotes and the key are
// why this is approximate — close enough to sit either side of a ceiling,
// which is all these tests need.
const payloadOf = (bytes: number) => ({ blob: "x".repeat(bytes) });

describe("#146: trajectory payload ceilings", () => {
  it("measures what the value costs to store, not what it contains", () => {
    expect(jsonByteLength(undefined)).toBe(0);
    expect(jsonByteLength(null)).toBe(4);
    expect(jsonByteLength({ a: 1 })).toBe(7);
    // Multi-byte characters are counted as bytes, not as characters — the
    // column stores UTF-8, and a ceiling measured in characters would be a
    // ceiling that moves with the language the agent is working in.
    expect(jsonByteLength("é")).toBe(4);
  });

  it("accepts a batch at the measured mean without comment", () => {
    // 833 B/event was the storage analysis's measured mean across 1,930 real
    // events; a full 1000-event batch of them is the realistic maximum, and it
    // has to fit or the ceiling is in the wrong place.
    const events = Array.from({ length: 1000 }, () => ({ payload: payloadOf(833) }));
    const result = checkEventPayloads(events);
    expect(result.ok).toBe(true);
  });

  it("refuses one oversized event, naming the event and the limit", () => {
    const events = [
      { payload: payloadOf(10) },
      { payload: payloadOf(MAX_EVENT_PAYLOAD_BYTES + 1), client_event_id: "evt-42" },
      { payload: payloadOf(10) },
    ];
    const result = checkEventPayloads(events);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");

    expect(result.errors).toHaveLength(1);
    const [error] = result.errors;
    // The index locates it in this request; the client_event_id locates it in
    // the producer's own world, which is the one it will retry from.
    expect(error!.path).toEqual(["events", 1, "payload"]);
    expect(error!.message).toContain("evt-42");
    expect(error!.message).toContain(String(MAX_EVENT_PAYLOAD_BYTES));
    expect(error!.code).toBe("too_big");
  });

  it("refuses a batch of individually-legal events that is collectively too large", () => {
    // The case the per-event ceiling alone cannot catch, and the reason there
    // are two numbers rather than one.
    const each = MAX_EVENT_PAYLOAD_BYTES - 1024;
    const count = Math.ceil(MAX_BATCH_PAYLOAD_BYTES / each) + 1;
    const events = Array.from({ length: count }, () => ({ payload: payloadOf(each) }));

    const result = checkEventPayloads(events);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");

    // No per-event error — every one of them is legal on its own.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.path).toEqual(["events"]);
    expect(result.errors[0]!.message).toContain(String(MAX_BATCH_PAYLOAD_BYTES));
    expect(result.errors[0]!.message).toContain("Split the batch");
  });

  it("reports every oversized event in one refusal, not just the first", () => {
    const events = [
      { payload: payloadOf(MAX_EVENT_PAYLOAD_BYTES + 1) },
      { payload: payloadOf(10) },
      { payload: payloadOf(MAX_EVENT_PAYLOAD_BYTES + 1) },
    ];
    const result = checkEventPayloads(events);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // A producer fixing one oversized event at a time is a producer making one
    // round trip per mistake.
    expect(result.errors.filter((e) => e.path[0] === "events" && e.path.length === 3)).toHaveLength(2);
  });

  it("gives a checkpoint the batch allowance, not the event one", () => {
    // A checkpoint is a whole harness's resumable state rather than one turn
    // of it, so a payload that would be refused as an event is fine here.
    expect(checkCheckpointState(payloadOf(MAX_EVENT_PAYLOAD_BYTES + 1)).ok).toBe(true);
    expect(checkCheckpointState(payloadOf(MAX_CHECKPOINT_STATE_BYTES + 1)).ok).toBe(false);
  });

  it("accepts an absent or null payload — the common case for a bare event", () => {
    expect(checkEventPayloads([{ payload: null }, {}]).ok).toBe(true);
    expect(checkCheckpointState(null).ok).toBe(true);
  });
});
