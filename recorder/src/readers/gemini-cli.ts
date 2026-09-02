import type { EventKind, EventStatus, TrajectoryEvent } from "../events.js";
import type { SessionFacts } from "./index.js";

// The third harness reader: Google's Gemini CLI.
//
// **A third reader is the test of whether the fixed vocabulary generalises or
// was fitted to two cases**, and it is worth saying what it found. Claude Code
// assembles one `tool_call` from a pair of lines; Codex collapses three lines
// carrying one item id; Gemini's non-interactive run is neither. Its
// `--output-format json` produces a *single object at the end* — the answer,
// and aggregate statistics about the run — so the interesting question here is
// not correlation but what to do when the harness reports counts where the
// vocabulary wants events.
//
// The answer is the clause #236 asked for: **report rather than coerce.** Nine
// tool calls that arrived as the number nine are recorded as the number nine,
// in a `custom` event that says so, rather than as nine invented `tool_call`
// events with no name, no argument and no outcome. A trajectory that claims
// detail it never had is worse than one that says what it has.
//
// Both shapes are read, because the CLI has both and which one a developer gets
// depends on their version:
//
//   summary   one JSON object, at the end — `response`, `stats`, `error`.
//   streamed  NDJSON, one event per line, for the streaming output format.
//
// The summary shape is the one this file is confident about. **The streamed
// event names are written against Gemini CLI's documented output rather than a
// captured transcript** — the same weakness `codex.ts` states about itself, and
// the reason this reader is deliberately forgiving: an unrecognised event type
// is kept under `custom` with its own name rather than dropped, so a format
// this is wrong about degrades to "recorded, unclassified" instead of to
// silence.

/** One line of Gemini's output, parsed. Deliberately loose: this is someone else's format. */
interface GeminiLine {
  // The summary shape.
  response?: string;
  error?: { type?: string; message?: string; code?: number };
  stats?: {
    models?: Record<
      string,
      {
        api?: { totalRequests?: number; totalErrors?: number; totalLatencyMs?: number };
        tokens?: {
          prompt?: number;
          candidates?: number;
          total?: number;
          cached?: number;
          thoughts?: number;
          tool?: number;
        };
      }
    >;
    tools?: {
      totalCalls?: number;
      totalSuccess?: number;
      totalFail?: number;
      totalDurationMs?: number;
      byName?: Record<string, { count?: number; success?: number; fail?: number; durationMs?: number }>;
    };
    files?: { totalLinesAdded?: number; totalLinesRemoved?: number };
  };

  // The streamed shape.
  type?: string;
  sessionId?: string;
  session_id?: string;
  model?: string;
  role?: string;
  content?: unknown;
  text?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  status?: string;
  durationMs?: number;
}

/** Gemini's tool outcomes, mapped onto ADP's. */
function toolStatus(status: string | undefined): EventStatus | undefined {
  switch (status?.toLowerCase()) {
    case "success":
    case "succeeded":
    case "ok":
      return "success";
    case "error":
      return "error";
    case "failed":
    case "failure":
      return "failure";
    case "cancelled":
    case "canceled":
      return "rejected";
    case "skipped":
      return "skipped";
    default:
      return undefined;
  }
}

export class GeminiCliReader {
  private facts: SessionFacts = {};
  /** Set when the summary object has already accounted for the run's tool calls. */
  private sawIndividualToolCalls = false;

  sessionFacts(): SessionFacts {
    return this.facts;
  }

  read(line: string): TrajectoryEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let parsed: GeminiLine;
    try {
      parsed = JSON.parse(trimmed) as GeminiLine;
    } catch {
      // A line this reader cannot parse is the harness's business, not a
      // reason to stop recording — and it is recorded *as* an unparseable
      // line, because a reader that silently ignores what it does not
      // understand is how a format change becomes a quiet loss of half the
      // trajectory. The same judgement both other readers make.
      return [
        {
          kind: "custom",
          type: "recorder.unparsed",
          status: "error",
          payload: { bytes: Buffer.byteLength(trimmed, "utf8") },
        },
      ];
    }

    // The summary object. Recognised by shape rather than by a type tag,
    // because it does not carry one.
    if (parsed.stats !== undefined || (parsed.response !== undefined && parsed.type === undefined)) {
      return this.readSummary(parsed);
    }

    return this.readStreamed(parsed);
  }

  end(): TrajectoryEvent[] {
    // Nothing is held between lines: this reader correlates nothing, because
    // the shape it reads gives it nothing to correlate. That is a real
    // difference from the other two and the reason it is stated — a third
    // reader whose `end()` is empty is evidence that the correlation in the
    // first two is a property of those harnesses rather than of the contract.
    return [];
  }

  private readSummary(parsed: GeminiLine): TrajectoryEvent[] {
    const events: TrajectoryEvent[] = [];

    if (parsed.response) {
      events.push({ kind: "message", type: "assistant", payload: { text: parsed.response } });
    }

    for (const [model, stats] of Object.entries(parsed.stats?.models ?? {})) {
      // The one place the summary maps cleanly onto the vocabulary: a model's
      // token counts are exactly what `model_call` carries, and recording them
      // is what makes #231's observed-model answer work for this harness at all.
      this.facts = { ...this.facts, model };
      events.push({
        kind: "model_call",
        type: "gemini.model_totals",
        model,
        tokens_in: stats.tokens?.prompt,
        tokens_out: stats.tokens?.candidates,
        duration_ms: stats.api?.totalLatencyMs,
        status: (stats.api?.totalErrors ?? 0) > 0 ? "failure" : "success",
        payload: { requests: stats.api?.totalRequests, tokens: stats.tokens },
      });
    }

    const tools = parsed.stats?.tools;
    if (tools && (tools.totalCalls ?? 0) > 0 && !this.sawIndividualToolCalls) {
      // **Reported, not coerced.** These are counts, and the vocabulary wants
      // events. Nine calls that arrived as the number nine are recorded as the
      // number nine — inventing nine `tool_call` events with no name, no
      // argument and no outcome would make the corpus claim a detail it never
      // had, which is worse than saying what it has.
      events.push({
        kind: "custom",
        type: "gemini.tool_totals",
        status: (tools.totalFail ?? 0) > 0 ? "failure" : "success",
        duration_ms: tools.totalDurationMs,
        payload: {
          note: "aggregate counts, not individual calls — this output format reports no per-call detail",
          totalCalls: tools.totalCalls,
          totalSuccess: tools.totalSuccess,
          totalFail: tools.totalFail,
          byName: tools.byName,
        },
      });
    }

    if (parsed.stats?.files) {
      events.push({ kind: "custom", type: "gemini.file_totals", payload: parsed.stats.files as unknown });
    }

    if (parsed.error) {
      events.push({
        kind: "custom",
        type: "gemini.error",
        status: "error",
        payload: { message: parsed.error.message, code: parsed.error.code, errorType: parsed.error.type },
      });
    }

    return events;
  }

  private readStreamed(parsed: GeminiLine): TrajectoryEvent[] {
    if (parsed.sessionId || parsed.session_id) {
      this.facts = { ...this.facts, harnessSessionId: parsed.sessionId ?? parsed.session_id };
    }
    if (parsed.model) this.facts = { ...this.facts, model: parsed.model };

    switch (parsed.type) {
      case "user":
      case "assistant":
      case "message":
        return [
          {
            kind: "message",
            type: parsed.role ?? parsed.type,
            model: parsed.model,
            payload: { text: parsed.text ?? parsed.content },
          },
        ];

      case "tool_call":
      case "tool_result":
      case "tool":
        // Emitted per line rather than correlated, because this shape carries
        // the outcome on the same line as the call. Where it does not, the
        // status is simply absent — which the schema allows, and which is the
        // honest record of a call whose outcome was never reported.
        this.sawIndividualToolCalls = true;
        return [
          {
            kind: "tool_call",
            type: parsed.name ?? "unknown",
            status: toolStatus(parsed.status),
            duration_ms: parsed.durationMs,
            payload: { args: parsed.args, result: parsed.result },
          },
        ];

      case "error":
        return [
          {
            kind: "custom",
            type: "gemini.error",
            status: "error",
            payload: { message: parsed.error?.message ?? parsed.text },
          },
        ];

      case undefined:
        return [
          {
            kind: "custom",
            type: "gemini.untyped",
            payload: parsed as unknown,
          },
        ];

      default:
        // Kept under `custom` with its own name rather than dropped. A format
        // this reader is wrong about then degrades to "recorded, unclassified"
        // instead of to silence, which is the whole reason the vocabulary has
        // an escape hatch.
        return [{ kind: "custom", type: `gemini.${parsed.type}`, payload: parsed as unknown }];
    }
  }
}

/** The kinds this reader can emit. Kept beside the reader, as the others are. */
export const EMITTED_KINDS: EventKind[] = ["message", "model_call", "tool_call", "custom"];

export function createReader(): GeminiCliReader {
  return new GeminiCliReader();
}
