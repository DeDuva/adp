// The first harness reader: Claude Code's `--output-format stream-json`.
//
// **Mapping is the recorder's job, and this file is where #149 says it goes.**
// The server stores `harness` as a string it never branches on, and that stays
// true only if nobody is tempted to teach it what a harness's private event
// names mean. So the translation happens out here, in a process that can be
// rewritten per harness without the store learning anything.
//
// The shape being read is NDJSON, one object per line, and the four types that
// matter are `system` (with `subtype: "init"`), `assistant`, `user` and
// `result`. `bench/lib/transcript.mjs` has been parsing the same stream since
// arm 2, which is why this file can be written against something real rather
// than against documentation.
//
// **A tool call is one event, assembled from two lines.** The harness emits
// the invocation as a `tool_use` block on an `assistant` line and the outcome
// as a `tool_result` block on a later `user` line. ADP's vocabulary has one
// `tool_call` kind carrying a `status`, and no field that would let two events
// point at each other — so emitting one event per line would double every
// tool-call count in the corpus and leave half of them with no outcome. The
// reader correlates instead, emitting when the fact is complete.
//
// What that costs is stated rather than hidden: a call still in flight when
// the stream ends is emitted at `end()` with no status, and a recorder killed
// between a call and its result loses that one call. The alternative — emit at
// invocation time — loses the *status of every call, always*, which is a worse
// record every day in exchange for a better one on the day you are killed.
import type { EventKind, EventStatus, TrajectoryEvent } from "../events.js";

/** One line of the harness's stream, parsed. Deliberately loose: this is someone else's format. */
interface StreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  message?: {
    model?: string;
    content?: ContentBlock[];
    usage?: { input_tokens?: number; output_tokens?: number };
    stop_reason?: string | null;
  };
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  is_error?: boolean;
  usage?: { input_tokens?: number; output_tokens?: number };
  permission_denials?: unknown[];
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** What the reader learned about the session itself, as opposed to what happened in it. */
export interface SessionFacts {
  harnessSessionId?: string;
  model?: string;
}

interface PendingCall {
  name: string;
  input: unknown;
  at: number;
}

export class ClaudeCodeReader {
  private readonly pending = new Map<string, PendingCall>();
  private facts: SessionFacts = {};
  /** Tool calls whose result never arrived, counted so `end()` can say so. */
  private unresolved = 0;

  /**
   * Feed one line; get back the events it completes.
   *
   * Zero, one or several — a single `assistant` line can carry text and two
   * tool calls, and a `user` line carrying two results completes two events.
   */
  read(line: string): TrajectoryEvent[] {
    const trimmed = line.trim();
    if (trimmed === "") return [];

    let parsed: StreamLine;
    try {
      parsed = JSON.parse(trimmed) as StreamLine;
    } catch {
      // A line this reader cannot parse is the harness's business, not a
      // reason to stop recording the session. It is recorded *as* an
      // unparseable line rather than skipped, because a reader that silently
      // ignores what it does not understand is how a format change becomes a
      // quiet loss of half the trajectory.
      return [
        {
          kind: "custom",
          type: "recorder.unparsed",
          status: "error",
          payload: { bytes: Buffer.byteLength(trimmed, "utf8") },
        },
      ];
    }

    switch (parsed.type) {
      case "system":
        return this.readSystem(parsed);
      case "assistant":
        return this.readAssistant(parsed);
      case "user":
        return this.readUser(parsed);
      case "result":
        return this.readResult(parsed);
      default:
        // An unrecognised *type* is different from an unparseable line: the
        // harness added something. Keep it, under `custom`, with its own name
        // — that is what the escape hatch in the vocabulary is for.
        return parsed.type
          ? [{ kind: "custom", type: `claude-code.${parsed.type}`, payload: parsed as unknown }]
          : [];
    }
  }

  private readSystem(line: StreamLine): TrajectoryEvent[] {
    if (line.subtype !== "init") {
      return [{ kind: "custom", type: `claude-code.system.${line.subtype ?? "unknown"}`, payload: line as unknown }];
    }
    // The harness's own session id is worth keeping — it is how someone
    // holding a local transcript finds the ADP session that recorded it — but
    // it is a fact about the session rather than an event in it, so it goes in
    // the payload of one `custom` event rather than onto every event after it.
    this.facts = { harnessSessionId: line.session_id, model: line.model };
    return [
      {
        kind: "custom",
        type: "claude-code.init",
        model: line.model,
        payload: { harness_session_id: line.session_id, model: line.model },
      },
    ];
  }

  private readAssistant(line: StreamLine): TrajectoryEvent[] {
    const events: TrajectoryEvent[] = [];
    const model = line.message?.model ?? this.facts.model;
    const usage = line.message?.usage;

    for (const block of line.message?.content ?? []) {
      if (block.type === "text" && block.text) {
        events.push({
          kind: "message",
          type: "assistant",
          model,
          tokens_in: usage?.input_tokens,
          tokens_out: usage?.output_tokens,
          payload: { text: block.text },
        });
      } else if (block.type === "tool_use" && block.id) {
        // Held, not emitted: see the note at the top of this file. The `id`
        // is the harness's own correlation handle and the only thing that
        // makes assembling the pair possible.
        this.pending.set(block.id, { name: block.name ?? "unknown", input: block.input, at: Date.now() });
      }
    }

    // The turn itself, when it carries nothing else worth recording — a
    // model call that only produced tool calls still cost tokens, and
    // dropping it would make the token totals wrong.
    if (events.length === 0 && usage) {
      events.push({
        kind: "model_call",
        type: line.message?.stop_reason ?? "",
        model,
        tokens_in: usage.input_tokens,
        tokens_out: usage.output_tokens,
      });
    }
    return events;
  }

  private readUser(line: StreamLine): TrajectoryEvent[] {
    const events: TrajectoryEvent[] = [];
    for (const block of line.message?.content ?? []) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      const call = this.pending.get(block.tool_use_id);
      this.pending.delete(block.tool_use_id);
      events.push({
        kind: "tool_call",
        // The tool's own name, which is what makes a trajectory comparable
        // across harnesses that call the same thing something else.
        type: call?.name ?? "unknown",
        status: block.is_error ? "failure" : "success",
        duration_ms: call ? Date.now() - call.at : undefined,
        payload: {
          input: call?.input,
          output: block.content,
          // A result whose invocation this reader never saw is a fact about
          // the recording, and saying so beats implying the input was empty.
          ...(call ? {} : { invocation_not_seen: true }),
        },
      });
    }
    return events;
  }

  private readResult(line: StreamLine): TrajectoryEvent[] {
    return [
      {
        kind: "custom",
        type: "claude-code.result",
        status: line.is_error ? "failure" : "success",
        duration_ms: line.duration_ms,
        tokens_in: line.usage?.input_tokens,
        tokens_out: line.usage?.output_tokens,
        // Micro-USD as an integer, matching the column: money in floating
        // point accumulates error over a corpus meant to be summed.
        cost_micro_usd:
          typeof line.total_cost_usd === "number" ? Math.round(line.total_cost_usd * 1_000_000) : undefined,
        payload: {
          subtype: line.subtype,
          num_turns: line.num_turns,
          is_error: line.is_error ?? false,
          permission_denials: (line.permission_denials ?? []).length,
        },
      },
    ];
  }

  /**
   * What is left when the stream stops.
   *
   * Tool calls still in flight are emitted here with no status, because a call
   * that was made is a fact even when its outcome is not. They are counted as
   * unresolved so the session says how many, rather than leaving a reader to
   * notice that some `tool_call` events have no `status` and guess why.
   */
  end(): TrajectoryEvent[] {
    const events: TrajectoryEvent[] = [];
    for (const [id, call] of this.pending) {
      this.unresolved += 1;
      events.push({
        kind: "tool_call",
        type: call.name,
        payload: { input: call.input, tool_use_id: id, result_not_seen: true },
      });
    }
    this.pending.clear();
    if (this.unresolved > 0) {
      events.push({
        kind: "custom",
        type: "recorder.unresolved_tool_calls",
        status: "error",
        payload: { count: this.unresolved, reason: "the stream ended before these tool calls reported a result" },
      });
    }
    return events;
  }

  sessionFacts(): SessionFacts {
    return { ...this.facts };
  }
}

/** The kinds this reader can emit, for the test that asserts it stays inside the vocabulary. */
export const EMITTED_KINDS: EventKind[] = ["message", "model_call", "tool_call", "custom"];
export const EMITTED_STATUSES: EventStatus[] = ["success", "failure", "error"];
