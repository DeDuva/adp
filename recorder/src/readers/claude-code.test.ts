import { describe, it, expect } from "vitest";
import { ClaudeCodeReader, EMITTED_KINDS, EMITTED_STATUSES } from "./claude-code.js";
import { EVENT_KINDS, EVENT_STATUSES } from "../events.js";

const line = (value: unknown) => JSON.stringify(value);

const assistantText = (text: string, usage?: { input_tokens: number; output_tokens: number }) =>
  line({ type: "assistant", message: { model: "claude-haiku-4-5", content: [{ type: "text", text }], usage } });

const toolUse = (id: string, name: string, input: unknown) =>
  line({ type: "assistant", message: { model: "claude-haiku-4-5", content: [{ type: "tool_use", id, name, input }] } });

const toolResult = (id: string, content: unknown, isError = false) =>
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });

function readAll(reader: ClaudeCodeReader, lines: string[]) {
  return lines.flatMap((l) => reader.read(l));
}

describe("ClaudeCodeReader", () => {
  it("never emits outside the vocabulary the server fixes", () => {
    // The one hard constraint on a reader: `kind` is a stored enum the server
    // does branch on, so a reader inventing one turns into a 422 at ingest —
    // and a quarantined session, which is the expensive way to find out.
    for (const kind of EMITTED_KINDS) expect(EVENT_KINDS).toContain(kind);
    for (const status of EMITTED_STATUSES) expect(EVENT_STATUSES).toContain(status);
  });

  it("turns an init line into one event and remembers the harness's own session id", () => {
    const reader = new ClaudeCodeReader();
    const events = reader.read(
      line({ type: "system", subtype: "init", session_id: "sess-abc", model: "claude-haiku-4-5" }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "custom", type: "claude-code.init", model: "claude-haiku-4-5" });
    // How someone holding a local transcript finds the ADP session that
    // recorded it. A fact about the session, so it rides in one payload
    // rather than on every event after it.
    expect(events[0]!.payload).toMatchObject({ harness_session_id: "sess-abc" });
    expect(reader.sessionFacts().harnessSessionId).toBe("sess-abc");
  });

  it("records assistant text as a message, with the turn's token counts", () => {
    const reader = new ClaudeCodeReader();
    const [event] = readAll(reader, [assistantText("on it", { input_tokens: 12, output_tokens: 34 })]);
    expect(event).toMatchObject({
      kind: "message",
      type: "assistant",
      model: "claude-haiku-4-5",
      tokens_in: 12,
      tokens_out: 34,
      payload: { text: "on it" },
    });
  });

  it("assembles one tool_call from the invocation and its result", () => {
    // The correlation that stops every tool-call count in the corpus from
    // doubling: the harness emits the call and the outcome on separate lines,
    // and ADP has one kind with a status and no way for two events to point at
    // each other.
    const reader = new ClaudeCodeReader();
    const events = readAll(reader, [
      toolUse("call-1", "Bash", { command: "npm test" }),
      toolResult("call-1", "4 passing"),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "tool_call",
      type: "Bash",
      status: "success",
      payload: { input: { command: "npm test" }, output: "4 passing" },
    });
    expect(typeof events[0]!.duration_ms).toBe("number");
  });

  it("marks a failed tool call as a failure rather than dropping it", () => {
    const reader = new ClaudeCodeReader();
    const events = readAll(reader, [
      toolUse("call-1", "Bash", { command: "false" }),
      toolResult("call-1", "exit 1", true),
    ]);
    expect(events[0]).toMatchObject({ kind: "tool_call", type: "Bash", status: "failure" });
  });

  it("handles several tool calls in one turn, and results that arrive out of order", () => {
    const reader = new ClaudeCodeReader();
    const first = reader.read(
      line({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "a", name: "Read", input: { path: "x" } },
            { type: "tool_use", id: "b", name: "Write", input: { path: "y" } },
          ],
        },
      }),
    );
    // Nothing yet: both calls are in flight.
    expect(first).toHaveLength(0);

    const later = readAll(reader, [toolResult("b", "wrote"), toolResult("a", "read")]);
    expect(later.map((e) => e.type)).toEqual(["Write", "Read"]);
  });

  it("keeps a model_call for a turn that produced only tool calls", () => {
    // Otherwise the token totals are wrong: a turn that spent tokens deciding
    // to call a tool would leave no trace of having spent them.
    const reader = new ClaudeCodeReader();
    const events = reader.read(
      line({
        type: "assistant",
        message: {
          model: "claude-haiku-4-5",
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "z", name: "Read", input: {} }],
          usage: { input_tokens: 100, output_tokens: 7 },
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "model_call", type: "tool_use", tokens_in: 100, tokens_out: 7 });
  });

  it("converts the final result's cost to integer micro-USD", () => {
    // Money in floating point accumulates error over a corpus meant to be
    // summed, which is why the column is an integer.
    const reader = new ClaudeCodeReader();
    const [event] = reader.read(
      line({
        type: "result",
        subtype: "success",
        total_cost_usd: 0.1435,
        duration_ms: 41_000,
        num_turns: 9,
        is_error: false,
        usage: { input_tokens: 900, output_tokens: 80 },
      }),
    );
    expect(event).toMatchObject({
      kind: "custom",
      type: "claude-code.result",
      status: "success",
      cost_micro_usd: 143_500,
      duration_ms: 41_000,
    });
    expect(event!.payload).toMatchObject({ num_turns: 9, is_error: false });
  });

  it("records a line it cannot parse instead of skipping it", () => {
    // A reader that silently ignores what it does not understand is how a
    // format change becomes a quiet loss of half a trajectory.
    const reader = new ClaudeCodeReader();
    const [event] = reader.read("{not json");
    expect(event).toMatchObject({ kind: "custom", type: "recorder.unparsed", status: "error" });
  });

  it("keeps a line type it has never seen, under the escape hatch", () => {
    const reader = new ClaudeCodeReader();
    const [event] = reader.read(line({ type: "something_new", detail: 1 }));
    expect(event).toMatchObject({ kind: "custom", type: "claude-code.something_new" });
    expect(event!.payload).toMatchObject({ type: "something_new", detail: 1 });
  });

  it("ignores blank lines", () => {
    const reader = new ClaudeCodeReader();
    expect(reader.read("")).toEqual([]);
    expect(reader.read("   \n")).toEqual([]);
  });

  it("emits a call still in flight when the stream ends, and says how many", () => {
    // The cost of correlating, stated rather than hidden. A call that was made
    // is a fact even when its outcome is not; what must not happen is the call
    // vanishing because its result never came.
    const reader = new ClaudeCodeReader();
    readAll(reader, [toolUse("call-1", "Bash", { command: "sleep 100" })]);
    const tail = reader.end();
    expect(tail[0]).toMatchObject({
      kind: "tool_call",
      type: "Bash",
      payload: { result_not_seen: true },
    });
    // No status, because there was no outcome — not "success" by default.
    expect(tail[0]!.status).toBeUndefined();
    expect(tail[1]).toMatchObject({ kind: "custom", type: "recorder.unresolved_tool_calls" });
    expect(tail[1]!.payload).toMatchObject({ count: 1 });
  });

  it("ends quietly when everything was resolved", () => {
    const reader = new ClaudeCodeReader();
    readAll(reader, [toolUse("call-1", "Bash", {}), toolResult("call-1", "ok")]);
    expect(reader.end()).toEqual([]);
  });

  it("records a result whose invocation it never saw, and says that too", () => {
    // What attaching to a transcript part-way through looks like. The event is
    // still worth having; implying the input was empty is not.
    const reader = new ClaudeCodeReader();
    const [event] = reader.read(toolResult("unknown-call", "output"));
    expect(event).toMatchObject({ kind: "tool_call", type: "unknown", status: "success" });
    expect(event!.payload).toMatchObject({ invocation_not_seen: true });
  });

  it("reads a whole session in order", () => {
    // The shape a real trial produces, end to end: init, a turn, a tool call
    // and its result, a closing message, the result line.
    const reader = new ClaudeCodeReader();
    const events = readAll(reader, [
      line({ type: "system", subtype: "init", session_id: "s1", model: "claude-haiku-4-5" }),
      assistantText("Looking at the repo", { input_tokens: 10, output_tokens: 5 }),
      toolUse("c1", "Bash", { command: "git status" }),
      toolResult("c1", "clean"),
      assistantText("Done", { input_tokens: 20, output_tokens: 3 }),
      line({ type: "result", subtype: "success", total_cost_usd: 0.002, num_turns: 3, is_error: false }),
    ]);
    expect(events.map((e) => `${e.kind}:${e.type}`)).toEqual([
      "custom:claude-code.init",
      "message:assistant",
      "tool_call:Bash",
      "message:assistant",
      "custom:claude-code.result",
    ]);
    expect(reader.end()).toEqual([]);
  });
});
