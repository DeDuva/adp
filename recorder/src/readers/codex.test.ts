import { describe, it, expect } from "vitest";
import { CodexReader, EMITTED_KINDS, EMITTED_STATUSES } from "./codex.js";
import { EVENT_KINDS, EVENT_STATUSES } from "../events.js";

const line = (value: unknown) => JSON.stringify(value);

const item = (id: string, type: string, rest: Record<string, unknown> = {}) => ({ id, type, ...rest });
const started = (i: object) => line({ type: "item.started", item: i });
const updated = (i: object) => line({ type: "item.updated", item: i });
const completed = (i: object) => line({ type: "item.completed", item: i });

function readAll(reader: CodexReader, lines: string[]) {
  return lines.flatMap((l) => reader.read(l));
}

describe("CodexReader", () => {
  it("never emits outside the vocabulary the server fixes", () => {
    // The one hard constraint on a reader, and the reason it is worth
    // asserting per reader rather than once: `kind` is a stored enum the
    // server does branch on, so a reader inventing one turns into a 422 at
    // ingest and a quarantined session.
    for (const kind of EMITTED_KINDS) expect(EVENT_KINDS).toContain(kind);
    for (const status of EMITTED_STATUSES) expect(EVENT_STATUSES).toContain(status);
  });

  it("remembers the thread id from the first line", () => {
    const reader = new CodexReader();
    const events = reader.read(line({ type: "thread.started", thread_id: "0199-abc" }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "custom", type: "codex.thread_started" });
    expect(events[0]!.payload).toMatchObject({ harness_session_id: "0199-abc" });
    // What lets someone holding `codex resume 0199-abc` find the ADP session
    // that recorded the thread.
    expect(reader.sessionFacts().harnessSessionId).toBe("0199-abc");
  });

  it("collapses an item's three lines into one event", () => {
    // The correlation the whole reader is built around: Codex reports an
    // item's life as started/updated/completed under one id, and emitting a
    // line each would multiply every tool-call count in the corpus while
    // leaving most of them reading `in_progress`.
    const reader = new CodexReader();
    const events = readAll(reader, [
      started(item("i1", "command_execution", { command: "npm test", status: "in_progress" })),
      updated(item("i1", "command_execution", { aggregated_output: "4 pass", status: "in_progress" })),
      completed(item("i1", "command_execution", { exit_code: 0, status: "completed" })),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "tool_call", type: "shell", status: "success" });
    // Merged, not replaced: `item.updated` is an update, and a later line is
    // not obliged to repeat what an earlier one said.
    expect(events[0]!.payload).toMatchObject({ command: "npm test", output: "4 pass", exit_code: 0 });
  });

  it("does not emit twice when a terminal status arrives before the completion", () => {
    // A failed command reports `failed` on the update *and* on the completion.
    // Emitting on the first terminal state would double it silently, on the
    // harness's schedule rather than ours.
    const reader = new CodexReader();
    const events = readAll(reader, [
      started(item("i1", "command_execution", { command: "npm test", status: "in_progress" })),
      updated(item("i1", "command_execution", { status: "failed" })),
      completed(item("i1", "command_execution", { exit_code: 1, status: "failed" })),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "tool_call", type: "shell", status: "failure" });
  });

  it("records a declined command as a rejected tool call", () => {
    // Not a `custom` event and not an absence. A command the sandbox refused
    // is the single most useful thing a trajectory can say about a run that
    // failed, which is why ADP's status vocabulary has `rejected` at all.
    const reader = new CodexReader();
    const [event] = readAll(reader, [
      completed(item("i9", "command_execution", { command: "rm -rf /", status: "declined" })),
    ]);
    expect(event).toMatchObject({ kind: "tool_call", type: "shell", status: "rejected" });
  });

  it("takes a file_change that was never started", () => {
    // Codex emits this item only as completed, so a reader that required a
    // `started` would drop every patch the agent applied.
    const reader = new CodexReader();
    const [event] = readAll(reader, [
      completed(item("p1", "file_change", { status: "completed", changes: [{ path: "a.ts", kind: "update" }] })),
    ]);
    expect(event).toMatchObject({ kind: "tool_call", type: "apply_patch", status: "success" });
    expect(event!.payload).toMatchObject({ changes: [{ path: "a.ts", kind: "update" }] });
  });

  it("qualifies an MCP tool by its server", () => {
    // Two servers may both offer `search`, and a trajectory that could not
    // tell them apart would answer the wrong question about which was slow.
    const reader = new CodexReader();
    const [event] = readAll(reader, [
      completed(item("m1", "mcp_tool_call", { server: "adp", tool: "proposal_merge", status: "failed" })),
    ]);
    expect(event).toMatchObject({ kind: "tool_call", type: "adp/proposal_merge", status: "failure" });
  });

  it("records agent text and reasoning as messages that say which they are", () => {
    const reader = new CodexReader();
    const events = readAll(reader, [
      completed(item("a1", "agent_message", { text: "on it" })),
      completed(item("r1", "reasoning", { text: "the test is the gate" })),
    ]);
    expect(events[0]).toMatchObject({ kind: "message", type: "assistant", payload: { text: "on it" } });
    expect(events[1]).toMatchObject({ kind: "message", type: "reasoning" });
  });

  it("carries a turn's token counts, and reports no cost at all", () => {
    const reader = new CodexReader();
    const [event] = readAll(reader, [
      line({
        type: "turn.completed",
        usage: { input_tokens: 900, cached_input_tokens: 800, output_tokens: 40, reasoning_output_tokens: 12 },
      }),
    ]);
    expect(event).toMatchObject({ kind: "model_call", status: "success", tokens_in: 900, tokens_out: 40 });
    // Absent, not zero. Codex reports no money, and a corpus that summed an
    // unknown as zero would be wrong in the direction that flatters us.
    expect(event!.cost_micro_usd).toBeUndefined();
    expect(event!.payload).toMatchObject({ cached_input_tokens: 800, reasoning_output_tokens: 12 });
  });

  it("collapses a running to-do list to the version that survived", () => {
    // The same shape as Claude Code's telemetry ticks — a value each new line
    // supersedes — and it needs no special case here, because hold-until-
    // completed already handles it.
    const reader = new CodexReader();
    const events = readAll(reader, [
      started(item("t1", "todo_list", { items: [{ text: "read the plan", completed: false }] })),
      updated(item("t1", "todo_list", { items: [{ text: "read the plan", completed: true }] })),
      completed(item("t1", "todo_list", { items: [{ text: "read the plan", completed: true }] })),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "custom", type: "codex.todo_list" });
  });

  it("keeps a stream-level error and an error item apart", () => {
    const reader = new CodexReader();
    const events = readAll(reader, [
      line({ type: "error", message: "stream died" }),
      completed(item("e1", "error", { message: "tool unavailable" })),
    ]);
    expect(events[0]).toMatchObject({ kind: "custom", type: "codex.error", status: "error" });
    expect(events[1]).toMatchObject({ kind: "custom", type: "codex.error_item", status: "error" });
  });

  it("keeps an unrecognised event and an unrecognised item, each under its own name", () => {
    // An unknown *type* is the harness adding something, which is what the
    // `custom` escape hatch is for. Dropping it is how a format change becomes
    // a quiet loss of half the trajectory.
    const reader = new CodexReader();
    const events = readAll(reader, [
      line({ type: "turn.paused", reason: "waiting" }),
      completed(item("x1", "hologram", { shimmer: 3 })),
    ]);
    expect(events[0]).toMatchObject({ kind: "custom", type: "codex.turn.paused" });
    expect(events[1]).toMatchObject({ kind: "custom", type: "codex.item.hologram" });
  });

  it("records an unparseable line rather than skipping it", () => {
    const reader = new CodexReader();
    const [event] = readAll(reader, ["{ this is not json"]);
    expect(event).toMatchObject({ kind: "custom", type: "recorder.unparsed", status: "error" });
  });

  it("emits what it was still holding when the stream stops, and says how many", () => {
    const reader = new CodexReader();
    readAll(reader, [started(item("i1", "command_execution", { command: "sleep 600", status: "in_progress" }))]);
    const events = reader.end();
    expect(events[0]).toMatchObject({ kind: "tool_call", type: "shell" });
    expect(events[0]!.status).toBeUndefined();
    expect(events[0]!.payload).toMatchObject({ item_id: "i1", completion_not_seen: true });
    // Counted, so the session says how many rather than leaving a reader to
    // notice some tool calls have no status and guess why.
    expect(events[1]).toMatchObject({ kind: "custom", type: "recorder.unresolved_tool_calls", status: "error" });
    expect(events[1]!.payload).toMatchObject({ count: 1 });
  });

  it("keeps the last status a held item reported", () => {
    // An item that reported `failed` and then went quiet failed; overwriting
    // that with "unknown" loses the more specific of the two facts.
    const reader = new CodexReader();
    readAll(reader, [updated(item("i2", "command_execution", { command: "npm test", status: "failed" }))]);
    const [event] = reader.end();
    expect(event).toMatchObject({ kind: "tool_call", status: "failure" });
    expect(event!.payload).toMatchObject({ completion_not_seen: true });
  });

  it("names no model, because the stream does not", () => {
    // Not a gap in the record: provenance carries `model` from the token the
    // session was minted with, so the fact exists where it is signed rather
    // than where it would have been inferred.
    const reader = new CodexReader();
    readAll(reader, [line({ type: "thread.started", thread_id: "t" }), line({ type: "turn.completed", usage: {} })]);
    expect(reader.sessionFacts().model).toBeUndefined();
  });
});

describe("CodexReader, on a stream that breaks its own schema", () => {
  it("emits an item with no id rather than holding one it can never match", () => {
    // Holding it would mean losing it: the completion, also unidentified,
    // would be a separate item. A visible duplicate is the better failure.
    const reader = new CodexReader();
    const events = reader.read(started(item("", "command_execution", { command: "ls", status: "in_progress" })));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "tool_call", type: "shell" });
    expect(reader.end()).toEqual([]);
  });
});
