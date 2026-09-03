import { readdirSync, statSync } from "node:fs";
import path from "node:path";

// Noticing that a harness has started a session, without the harness telling
// anyone.
//
// `tail` needs a file, and something has to know which. For Claude Code that
// something is the harness itself — a `SessionStart` hook is handed the
// transcript path — and for a harness with no hook the answer used to be
// `wrap`, which is a different command the developer has to remember to type
// instead of their normal one. That is not ambient capture; it is capture the
// developer performs, and it fails silently the first time they forget.
//
// So: watch the directory the harness writes its transcripts into, and start a
// `tail` for each new one. The harness needs no flag, no hook and no knowledge
// that anything is watching — which is #149's original claim, restored for the
// harnesses that cannot hook.
//
// Polled rather than `fs.watch`ed, for the reason tail.ts gives at greater
// length: `fs.watch` is the one Node API whose semantics genuinely differ per
// platform, and this project's own machines run WSL2, where inotify does not
// fire for writes made from the Windows side.

export const DEFAULT_WATCH_POLL_MS = 2000;

export interface WatchOptions {
  pollMs?: number;
  /** Only files whose name matches. Defaults to the `.jsonl` every reader here expects. */
  match?: RegExp;
  /**
   * Record transcripts that already existed when the watch started.
   *
   * Off by default, and that is the important default: a directory of past
   * sessions is history, and a watcher that ingested all of it on every start
   * would re-record the developer's entire back catalogue every time they
   * reconnected.
   */
  backfill?: boolean;
  /** How deep to look. Codex nests sessions under dated directories. */
  maxDepth?: number;
}

/**
 * Calls `onFile` once for each transcript that appears.
 *
 * Files are reported in modification order, so a burst that appears between two
 * polls is recorded in the order it was written rather than in whatever order
 * the filesystem lists.
 */
export function watchDir(
  dir: string,
  onFile: (file: string) => void,
  options: WatchOptions = {},
): { stop: () => void; poll: () => void } {
  const pollMs = options.pollMs ?? DEFAULT_WATCH_POLL_MS;
  const match = options.match ?? /\.jsonl$/;
  const maxDepth = options.maxDepth ?? 3;
  const seen = new Set<string>();
  let stopped = false;

  // Everything already there is history unless asked for. Seeded before the
  // first poll rather than skipped inside it, so a file that appears *during*
  // the first poll is still new.
  if (!options.backfill) for (const entry of list(dir, match, maxDepth)) seen.add(entry.file);

  const poll = () => {
    if (stopped) return;
    const fresh = list(dir, match, maxDepth)
      .filter((entry) => !seen.has(entry.file))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of fresh) {
      seen.add(entry.file);
      onFile(entry.file);
    }
  };

  const timer = setInterval(poll, pollMs);
  // Never holds the process open on its own: the caller decides when this ends,
  // and a watcher that kept an otherwise-finished process alive would be a
  // background job nobody asked for.
  timer.unref?.();

  return {
    poll,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function list(dir: string, match: RegExp, depth: number): { file: string; mtimeMs: number }[] {
  if (depth < 0) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // A directory that does not exist yet is the ordinary state before the
    // harness has ever run. Reported as empty rather than thrown, so the watch
    // survives being started first.
    return [];
  }

  const out: { file: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...list(full, match, depth - 1));
      continue;
    }
    if (!entry.isFile() || !match.test(entry.name)) continue;
    try {
      out.push({ file: full, mtimeMs: statSync(full).mtimeMs });
    } catch {
      // Vanished between the listing and the stat. Nothing to record.
    }
  }
  return out;
}
