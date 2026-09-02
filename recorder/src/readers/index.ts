// The reader contract, and the harnesses that ship with one.
//
// **A harness reader is the only part of ADP that knows what a harness's
// events mean, and it lives in a client on purpose.** `sessions.harness` is a
// string the server stores and never branches on — that is what makes the
// protocol harness-neutral, and it stays true only if nobody is ever tempted
// to teach the server one vendor's private event names. So translation happens
// out here, in a process that can be rewritten per harness while the store
// learns nothing. Shipping adapters is not the same as being adapter-aware;
// `adapters/` already holds that line for scanners, and this holds it for
// harnesses.
//
// **The interface is three methods, and it is the extension point.** A reader
// for a harness ADP has never heard of is a module exporting `createReader`,
// pointed at with `--reader ./my-reader.js`. Nothing in this package has to
// change to run it, which is the difference between an interface and a list.
//
// What a reader may emit is fixed: `events.ts` holds the vocabulary, and
// `normalizeEvent` is applied to everything a reader returns before it reaches
// the spool. That guard exists because the failure it prevents is total rather
// than local — an out-of-vocabulary `kind` is a 422 at ingest, a 422
// quarantines the shipper, and one bad event from a third-party reader would
// therefore cost the whole session rather than itself.
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { TrajectoryEvent } from "../events.js";
import { ClaudeCodeReader } from "./claude-code.js";
import { CodexReader } from "./codex.js";
import { GeminiCliReader } from "./gemini-cli.js";

/** What the reader learned about the session itself, as opposed to what happened in it. */
export interface SessionFacts {
  /** The harness's own id for this session, so a local transcript can be matched to an ADP one. */
  harnessSessionId?: string;
  /** The model the stream names, where it names one. */
  model?: string;
}

/**
 * The whole contract.
 *
 * `read` is given one line of the harness's stream and returns the events that
 * line *completes* — zero, one, or several. Returning zero is normal and is
 * how correlation works: a reader that has seen a tool call but not its
 * outcome holds it, because ADP has one `tool_call` kind carrying a status and
 * no field that would let two events point at each other.
 *
 * `end` is called once when the stream stops, and returns what the reader was
 * still holding. Anything a reader would rather report as a summary than as
 * one event each — a counter, a count of what it could not resolve — belongs
 * here.
 *
 * `sessionFacts` is optional and is polled after every line. It is for facts
 * *about* the session rather than events in it; the recorder writes them to
 * the spool's sidecar, where `flush` can still find them after the process
 * that read them is gone.
 *
 * A reader must not throw. The recorder calls it on the session's only path,
 * and a reader that dies takes the recording with it — so a line a reader
 * cannot make sense of is recorded *as* an unreadable line rather than raised,
 * which is also the only way a format change shows up as something other than
 * a quiet loss of half the trajectory.
 */
export interface Reader {
  read(line: string): TrajectoryEvent[];
  end(): TrajectoryEvent[];
  sessionFacts?(): SessionFacts;
}

export type ReaderFactory = () => Reader;

/** A harness this recorder can read without being told anything. */
export interface HarnessReader {
  /** Stored verbatim as `sessions.harness`, and the value `--harness` takes. */
  harness: string;
  /** The stream it reads — the thing an adopter has to be able to produce. */
  stream: string;
  create: ReaderFactory;
}

/**
 * The two that ship, chosen for having a stable machine-readable event stream
 * rather than for being the most popular — which is the criterion #150 sets,
 * and the only one that makes a reader something other than a scraping project.
 */
export const BUILTIN_READERS: HarnessReader[] = [
  {
    harness: "claude-code",
    stream: "`claude --output-format stream-json`, or the session transcript it writes",
    create: () => new ClaudeCodeReader(),
  },
  {
    harness: "codex",
    stream: "`codex exec --json`",
    create: () => new CodexReader(),
  },
  {
    harness: "gemini-cli",
    stream: "`gemini --output-format json`, and the streaming form where the CLI offers one",
    create: () => new GeminiCliReader(),
  },
];

export const DEFAULT_HARNESS = "claude-code";

export function builtinHarnesses(): string[] {
  return BUILTIN_READERS.map((r) => r.harness);
}

/** The built-in reader for a harness, or null when there is none — which is not an error here. */
export function createBuiltinReader(harness: string): Reader | null {
  return BUILTIN_READERS.find((r) => r.harness === harness)?.create() ?? null;
}

/** A duck-type check, because the module being loaded was not compiled against our types. */
function isReader(value: unknown): value is Reader {
  const candidate = value as Reader | null;
  return typeof candidate?.read === "function" && typeof candidate?.end === "function";
}

/**
 * Load a reader nobody here wrote.
 *
 * The specifier is a module path — relative or absolute — or a bare package
 * name. A relative path is resolved against the working directory rather than
 * against this file, because the person typing it is thinking about their
 * repository and not about where `adp-recorder` happens to be installed.
 *
 * The module exports `createReader` (or a default export that is one). Both
 * the export and what it returns are checked here, in the one place where the
 * failure is still a startup error with a message. A reader validated later —
 * or not at all — fails as a session that recorded nothing, which is the
 * outcome this whole component exists to prevent.
 */
export async function loadReaderModule(specifier: string): Promise<Reader> {
  const target =
    specifier.startsWith(".") || path.isAbsolute(specifier)
      ? pathToFileURL(path.resolve(process.cwd(), specifier)).href
      : specifier;

  let module: Record<string, unknown>;
  try {
    module = (await import(target)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`cannot load reader module '${specifier}': ${err instanceof Error ? err.message : String(err)}`);
  }

  const factory = module.createReader ?? module.default;
  if (typeof factory !== "function") {
    throw new Error(`reader module '${specifier}' exports no 'createReader' function (nor a default export that is one)`);
  }

  const reader: unknown = (factory as ReaderFactory)();
  if (!isReader(reader)) {
    throw new Error(`reader module '${specifier}' returned something that is not a reader: it needs read() and end()`);
  }
  return reader;
}

/**
 * Pick the reader for this session: an explicit module wins, then the harness
 * name, and an unknown harness with no module is refused rather than defaulted.
 *
 * Refusing is the point. Falling back to the default reader would record a
 * codex session under `claude-code`'s parser, which produces a trajectory of
 * `custom` events that looks like a successful recording and is worthless —
 * and the person who typed the wrong harness name finds out days later, from
 * the record they were relying on.
 */
export async function resolveReader(options: { harness: string; module?: string }): Promise<Reader> {
  if (options.module) return loadReaderModule(options.module);
  const builtin = createBuiltinReader(options.harness);
  if (builtin) return builtin;
  throw new Error(
    `no reader for harness '${options.harness}'. Built in: ${builtinHarnesses().join(", ")}. ` +
      `Pass --reader <module> to use your own, or see the recorder section of README.md for what an ` +
      `unsupported harness still gets.`,
  );
}
