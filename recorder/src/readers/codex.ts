// The second harness reader: OpenAI Codex CLI's `codex exec --json`.
//
// The stream is JSONL, one `ThreadEvent` per line, and it is a *thread* of
// items rather than a conversation of messages — which makes it a genuinely
// different shape from the first reader's and therefore the useful second one
// to have. Its schema is declared in `codex-rs/exec/src/exec_events.rs` and
// re-exported as TypeScript in `sdk/typescript/src/{events,items}.ts`; this
// file was written against those rather than against a captured transcript,
// which is the one way it is weaker than `claude-code.ts` and is said here
// rather than discovered later. The reader is correspondingly forgiving: an
// unknown event type, an unknown item type and an unparseable line each have
// a defined outcome that keeps the session recording.
//
// **Three lines collapse into one event, and that is the same decision the
// first reader made from the opposite direction.** Codex reports an item's
// life as `item.started`, any number of `item.updated`, and `item.completed`,
// all carrying the same `id`. ADP has one `tool_call` kind with a `status` and
// no field that would let two events point at each other, so emitting a line
// each would multiply every tool-call count in the corpus and leave most of
// them reading `in_progress`. The reader accumulates the item and emits once,
// on `item.completed`.
//
// That rule also disposes of the case the first reader needed a special one
// for: `todo_list` is a running to-do list re-emitted on every change, exactly
// the shape of Claude Code's `thinking_tokens` ticks, and holding-until-
// terminal already collapses it to the one version that survived.
//
// What it costs is stated rather than hidden: an item still in flight when the
// stream ends is emitted by `end()` with no status, and a recorder killed
// mid-command loses that one item's outcome. `file_change` is the exception
// that proves the rule is right — Codex emits it *only* as completed, so the
// reader must never require a `started` it will not get.
import type { EventKind, EventStatus, TrajectoryEvent } from "../events.js";
import type { SessionFacts } from "./index.js";

/** One line of the harness's stream, parsed. Deliberately loose: this is someone else's format. */
interface ThreadEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    cache_write_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  item?: ThreadItem;
}

interface ThreadItem {
  id?: string;
  type?: string;
  status?: string;
  // agent_message, reasoning, error
  text?: string;
  message?: string;
  // command_execution
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  // file_change
  changes?: { path?: string; kind?: string }[];
  // mcp_tool_call
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  // web_search
  query?: string;
  // todo_list
  items?: { text?: string; completed?: boolean }[];
}

/**
 * Codex's item statuses, mapped onto ADP's.
 *
 * `declined` is the one worth naming. A command the sandbox refused is a
 * **tool call with an outcome**, not an absence — the same fact Claude Code
 * reports as `permission_denied`, and the same reason ADP's status vocabulary
 * has `rejected` at all. In the first real Claude Code session recorded there
 * were twelve of them and they were the entire explanation of why that trial
 * did not land; a reader that dropped Codex's equivalent would lose the same
 * explanation on the other harness.
 *
 * `in_progress` maps to nothing: an item that has not finished has no outcome,
 * and inventing one is worse than leaving `status` unset.
 */
const STATUS: Record<string, EventStatus | undefined> = {
  completed: "success",
  failed: "failure",
  declined: "rejected",
  in_progress: undefined,
};

export class CodexReader {
  /** Items seen but not yet terminal, by the harness's own id. */
  private readonly pending = new Map<string, ThreadItem>();
  private facts: SessionFacts = {};
  /** Items whose terminal state never arrived, counted so `end()` can say so. */
  private unresolved = 0;

  read(line: string): TrajectoryEvent[] {
    const trimmed = line.trim();
    if (trimmed === "") return [];

    let parsed: ThreadEvent;
    try {
      parsed = JSON.parse(trimmed) as ThreadEvent;
    } catch {
      // A line this reader cannot parse is the harness's business, not a
      // reason to stop recording. Recorded *as* an unparseable line rather
      // than skipped: a reader that silently ignores what it does not
      // understand is how a format change becomes a quiet loss of half the
      // trajectory.
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
      case "thread.started":
        // A fact about the session rather than an event in it, so it rides in
        // one payload instead of on every event after it — and it is what
        // lets someone holding `codex resume <thread_id>` find the ADP
        // session that recorded the thread.
        this.facts = { ...this.facts, harnessSessionId: parsed.thread_id };
        return [
          {
            kind: "custom",
            type: "codex.thread_started",
            payload: { harness_session_id: parsed.thread_id },
          },
        ];

      case "turn.started":
        // Nothing to record yet: the turn's cost arrives with its completion,
        // and an event per turn boundary would be two rows saying a turn
        // happened around events that already say so.
        return [];

      case "turn.completed":
        return [
          {
            kind: "model_call",
            type: "turn",
            status: "success",
            tokens_in: parsed.usage?.input_tokens,
            tokens_out: parsed.usage?.output_tokens,
            // Kept because the totals above do not imply them and a cost
            // analysis prices a cached input token differently from a fresh
            // one. Codex reports no money, so `cost_micro_usd` stays unset —
            // absent and zero are different, and a corpus that summed them
            // would be wrong in the direction that flatters us.
            payload: {
              cached_input_tokens: parsed.usage?.cached_input_tokens,
              cache_write_input_tokens: parsed.usage?.cache_write_input_tokens,
              reasoning_output_tokens: parsed.usage?.reasoning_output_tokens,
            },
          },
        ];

      case "turn.failed":
        return [
          {
            kind: "model_call",
            type: "turn",
            status: "failure",
            payload: { error: parsed.error?.message },
          },
        ];

      case "item.started":
      case "item.updated":
      case "item.completed":
        return this.readItem(parsed);

      case "error":
        // The stream's own fatal error, distinct from an `error` *item*: this
        // one ends the thread.
        return [{ kind: "custom", type: "codex.error", status: "error", payload: { message: parsed.message } }];

      default:
        // An unrecognised type is different from an unparseable line: the
        // harness added something. Keep it, under `custom`, with its own name
        // — that is what the escape hatch in the vocabulary is for.
        return parsed.type
          ? [{ kind: "custom", type: `codex.${parsed.type}`, payload: parsed as unknown }]
          : [];
    }
  }

  private readItem(line: ThreadEvent): TrajectoryEvent[] {
    const item = line.item;
    if (!item) return [];

    // Merged rather than replaced: `item.updated` is documented as an update,
    // and a later line is not obliged to repeat what an earlier one said.
    const merged = { ...(item.id ? (this.pending.get(item.id) ?? {}) : {}), ...item };

    // **`item.completed` is the only line that emits**, even when an earlier
    // one already carried a terminal status. Emitting on the first terminal
    // state instead would double any item that reports one and then completes,
    // which is the exact bug this whole hold-and-correlate design exists to
    // avoid — and it would do it silently, on the harness's schedule rather
    // than on ours. An item that never completes is not lost: `end()` has it.
    if (line.type !== "item.completed") {
      // An item with no id cannot be correlated with anything, so holding it
      // means losing it — the completion, also unidentified, would be a
      // separate item. The schema says `id` is always there; if a version
      // stops sending one, a visible duplicate is the better failure than a
      // silent drop, so it is emitted now.
      if (!item.id) return [this.toEvent(merged)];
      this.pending.set(item.id, merged);
      return [];
    }
    if (item.id) this.pending.delete(item.id);
    return [this.toEvent(merged)];
  }

  /** One finished item, as the one ADP event that describes it. */
  private toEvent(item: ThreadItem): TrajectoryEvent {
    const status = item.status ? STATUS[item.status] : undefined;
    switch (item.type) {
      case "agent_message":
        return { kind: "message", type: "assistant", payload: { text: item.text } };

      case "reasoning":
        // A message the model addressed to itself. ADP has no `reasoning`
        // kind and does not need one — what a reader owes the record is the
        // turn's content and who it was from, and `message` carries both.
        return { kind: "message", type: "reasoning", payload: { text: item.text } };

      case "command_execution":
        return {
          kind: "tool_call",
          // `shell`, not the command line. Claude Code's reader records the
          // tool's own name because that is what makes a trajectory
          // comparable; Codex's shell tool has no name here, only the command
          // it ran — and using that as `type` would make the column unbounded
          // and every distinct command a distinct "tool". Whether Codex's
          // `shell` and Claude Code's `Bash` are the same tool is a question
          // for whoever reads the corpus. Answering it here would mean this
          // process inventing a cross-harness tool taxonomy and writing its
          // guesses into the permanent record.
          type: "shell",
          status,
          payload: {
            command: item.command,
            exit_code: item.exit_code,
            output: item.aggregated_output,
          },
        };

      case "file_change":
        return {
          kind: "tool_call",
          type: "apply_patch",
          status,
          payload: { changes: item.changes },
        };

      case "mcp_tool_call":
        return {
          kind: "tool_call",
          // Qualified by its server, because two servers may both offer
          // `search` and a trajectory that could not tell them apart would be
          // answering the wrong question about which one was slow.
          type: item.server ? `${item.server}/${item.tool ?? "unknown"}` : (item.tool ?? "unknown"),
          status,
          payload: { arguments: item.arguments, result: item.result },
        };

      case "web_search":
        return { kind: "tool_call", type: "web_search", status: status ?? "success", payload: { query: item.query } };

      case "todo_list":
        return { kind: "custom", type: "codex.todo_list", payload: { items: item.items } };

      case "error":
        // An error *item* is a non-fatal error the agent was told about, and
        // it belongs in the trajectory as one — unlike the stream-level
        // `error`, the thread continues after it.
        return { kind: "custom", type: "codex.error_item", status: "error", payload: { message: item.message } };

      default:
        return { kind: "custom", type: `codex.item.${item.type ?? "unknown"}`, payload: item as unknown };
    }
  }

  /**
   * What is left when the stream stops.
   *
   * Items still in flight are emitted with no status, because an item that
   * started is a fact even when its outcome is not, and they are counted so
   * the session says how many rather than leaving a reader to notice some
   * `tool_call` events have no `status` and guess why.
   */
  end(): TrajectoryEvent[] {
    const events: TrajectoryEvent[] = [];
    for (const [id, item] of this.pending) {
      this.unresolved += 1;
      const event = this.toEvent(item);
      events.push({
        ...event,
        // Whatever status the last line carried is kept — an item that
        // reported `failed` and then went quiet failed, and overwriting that
        // with "unknown" would lose the more specific fact of the two.
        payload: { ...(event.payload as Record<string, unknown>), item_id: id, completion_not_seen: true },
      });
    }
    this.pending.clear();
    if (this.unresolved > 0) {
      events.push({
        kind: "custom",
        type: "recorder.unresolved_tool_calls",
        status: "error",
        payload: { count: this.unresolved, reason: "the stream ended before these items reached a terminal state" },
      });
    }
    return events;
  }

  /**
   * No model, and deliberately not guessed.
   *
   * Codex's stream never names the model — not on `thread.started`, not on
   * `turn.completed`. That is not a gap in the record: provenance carries
   * `model` from the token the session was minted with (#141), so the fact
   * exists where it is signed rather than where it would have been inferred.
   */
  sessionFacts(): SessionFacts {
    return { ...this.facts };
  }
}

/** The kinds this reader can emit, for the test that asserts it stays inside the vocabulary. */
export const EMITTED_KINDS: EventKind[] = ["message", "model_call", "tool_call", "custom"];
export const EMITTED_STATUSES: EventStatus[] = ["success", "failure", "error", "rejected"];
