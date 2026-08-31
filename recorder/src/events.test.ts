import { describe, it, expect } from "vitest";
import { normalizeEvent, type TrajectoryEvent } from "./events.js";

describe("normalizeEvent", () => {
  it("leaves a valid event exactly as the reader wrote it", () => {
    const event: TrajectoryEvent = { kind: "tool_call", type: "shell", status: "success", payload: { a: 1 } };
    expect(normalizeEvent(event)).toBe(event);
  });

  it("relabels an out-of-vocabulary kind rather than dropping the event", () => {
    // The cost of not doing this is total rather than local: an unknown
    // `kind` is a 422 at ingest, a 422 quarantines the shipper, so one typo in
    // a third-party reader would cost the whole session.
    const event = normalizeEvent({ kind: "thought" as never, type: "pondering", payload: { text: "hmm" } });
    expect(event.kind).toBe("custom");
    // Named, so the record says a reader emitted something outside the
    // vocabulary — which is the only way anyone finds out.
    expect(event.type).toBe("recorder.invalid_event(kind=thought) pondering");
    // And everything else arrives intact: this is a relabelling, not a repair.
    expect(event.payload).toEqual({ text: "hmm" });
  });

  it("drops an out-of-vocabulary status and keeps the event's kind", () => {
    const event = normalizeEvent({ kind: "tool_call", type: "shell", status: "maybe" as never, tokens_in: 7 });
    expect(event.kind).toBe("tool_call");
    expect(event.status).toBeUndefined();
    expect(event.type).toBe("recorder.invalid_event(status=maybe) shell");
    expect(event.tokens_in).toBe(7);
  });

  it("names both when both are wrong, and truncates what it quotes", () => {
    // `type` is unbounded text on the wire, so a reader building a kind out of
    // user input must not get to write all of it down.
    const event = normalizeEvent({ kind: "x".repeat(300) as never, status: "y" as never });
    expect(event.type).toMatch(/^recorder\.invalid_event\(kind=x{64},status=y\)$/);
  });
});
