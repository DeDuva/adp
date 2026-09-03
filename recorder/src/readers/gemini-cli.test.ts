import { describe, it, expect } from "vitest";
import { GeminiCliReader, createReader } from "./gemini-cli.js";
import { normalizeEvent } from "../events.js";
import { resolveReader } from "./index.js";

// #236 — the third reader, and the test of whether the vocabulary generalises.
//
// Claude Code assembles one `tool_call` from a pair of lines; Codex collapses
// three lines carrying one item id. Gemini's non-interactive run is neither: it
// produces a single object at the end, with the answer and aggregate statistics.
// So the interesting question here is not correlation but what a reader does
// when the harness reports *counts* where the vocabulary wants events.
describe("the Gemini CLI reader", () => {
  const summary = {
    response: "I changed three files.",
    stats: {
      models: {
        "gemini-2.5-pro": {
          api: { totalRequests: 4, totalErrors: 0, totalLatencyMs: 8100 },
          tokens: { prompt: 1200, candidates: 340, total: 1540, cached: 0, thoughts: 0, tool: 0 },
        },
      },
      tools: {
        totalCalls: 9,
        totalSuccess: 8,
        totalFail: 1,
        totalDurationMs: 2400,
        byName: { read_file: { count: 6, success: 6, fail: 0 } },
      },
      files: { totalLinesAdded: 40, totalLinesRemoved: 3 },
    },
  };

  it("records the answer as a message and the model's totals as a model_call", () => {
    const reader = new GeminiCliReader();
    const events = reader.read(JSON.stringify(summary));

    expect(events.find((e) => e.kind === "message")?.payload).toMatchObject({
      text: "I changed three files.",
    });
    const call = events.find((e) => e.kind === "model_call")!;
    expect(call).toMatchObject({
      model: "gemini-2.5-pro",
      tokens_in: 1200,
      tokens_out: 340,
      duration_ms: 8100,
      status: "success",
    });
    // Which is what makes #231's observed-model answer work for this harness
    // at all — an observation, rather than the token's claim.
    expect(reader.sessionFacts().model).toBe("gemini-2.5-pro");
  });

  // The clause #236 asked for, and the whole reason this reader is interesting.
  it("reports tool counts as counts rather than inventing calls it never saw", () => {
    const events = new GeminiCliReader().read(JSON.stringify(summary));

    // Not nine tool_call events with no name, no argument and no outcome. A
    // trajectory that claims detail it never had is worse than one that says
    // what it has.
    expect(events.filter((e) => e.kind === "tool_call")).toHaveLength(0);

    const totals = events.find((e) => e.type === "gemini.tool_totals")!;
    expect(totals.kind).toBe("custom");
    expect(totals.status).toBe("failure");
    expect(totals.payload).toMatchObject({ totalCalls: 9, totalSuccess: 8, totalFail: 1 });
    // And says so in the record, so a reader of the corpus is not left to work
    // out why one harness's sessions have no tool calls in them.
    expect((totals.payload as { note: string }).note).toContain("aggregate counts, not individual calls");
  });

  it("records an error the CLI reports, without losing the rest of the summary", () => {
    const events = new GeminiCliReader().read(
      JSON.stringify({ ...summary, error: { type: "ApiError", message: "quota exhausted", code: 429 } }),
    );
    expect(events.find((e) => e.type === "gemini.error")).toMatchObject({
      status: "error",
      payload: { message: "quota exhausted", code: 429 },
    });
    expect(events.find((e) => e.kind === "message")).toBeDefined();
  });

  describe("the streamed form", () => {
    it("maps a tool call that carries its own outcome", () => {
      const reader = new GeminiCliReader();
      const [event] = reader.read(
        JSON.stringify({ type: "tool_call", name: "read_file", status: "success", durationMs: 12, args: { path: "a" } }),
      );
      expect(event).toMatchObject({ kind: "tool_call", type: "read_file", status: "success", duration_ms: 12 });
    });

    // Where the individual calls did arrive, the aggregate must not be
    // recorded beside them — that would double every count in the corpus,
    // which is the failure both other readers were written to avoid.
    it("drops the aggregate once it has seen the calls themselves", () => {
      const reader = new GeminiCliReader();
      reader.read(JSON.stringify({ type: "tool_call", name: "read_file", status: "success" }));
      const events = reader.read(JSON.stringify(summary));
      expect(events.find((e) => e.type === "gemini.tool_totals")).toBeUndefined();
    });

    it("keeps the session id, so a local transcript can be matched to an ADP one", () => {
      const reader = new GeminiCliReader();
      reader.read(JSON.stringify({ type: "assistant", sessionId: "abc-123", text: "hi" }));
      expect(reader.sessionFacts().harnessSessionId).toBe("abc-123");
    });

    // A format this reader is wrong about degrades to "recorded, unclassified"
    // rather than to silence, which is the whole reason the vocabulary has an
    // escape hatch.
    it("keeps an event type it does not recognise, under its own name", () => {
      const [event] = new GeminiCliReader().read(JSON.stringify({ type: "thought", text: "hmm" }));
      expect(event).toMatchObject({ kind: "custom", type: "gemini.thought" });
    });

    it("records an unparseable line as one, rather than skipping it", () => {
      const [event] = new GeminiCliReader().read("{not json");
      expect(event).toMatchObject({ kind: "custom", type: "recorder.unparsed", status: "error" });
    });
  });

  // Nothing is held between lines, because the shape this reads gives it
  // nothing to correlate. Stated as a test because it is evidence about the
  // *contract*: the correlation in the other two readers is a property of
  // those harnesses rather than something the interface requires.
  it("holds nothing at the end of the stream", () => {
    const reader = new GeminiCliReader();
    reader.read(JSON.stringify(summary));
    expect(reader.end()).toEqual([]);
  });

  it("emits only kinds the vocabulary allows", () => {
    const reader = new GeminiCliReader();
    const events = [
      ...reader.read(JSON.stringify(summary)),
      ...reader.read(JSON.stringify({ type: "tool_call", name: "x", status: "failed" })),
      ...reader.read(JSON.stringify({ type: "made_up" })),
      ...reader.end(),
    ];
    for (const event of events) {
      // `normalizeEvent` relabels anything outside the vocabulary and says a
      // reader did it — so a reader that needed relabelling is a reader with a
      // bug, and this asserts none is needed.
      expect(normalizeEvent(event)).toEqual(event);
    }
  });

  it("is a built-in, resolvable by harness name", () => {
    const resolved = resolveReader({ harness: "gemini-cli" });
    expect(resolved).not.toBeNull();
  });

  it("is loadable the way a third-party reader would be", () => {
    expect(createReader()).toBeInstanceOf(GeminiCliReader);
  });
});
