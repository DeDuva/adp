// Following a file the harness is still writing.
//
// **Tailing is the primary way to attach, and that is a design choice with a
// reason.** #149 says the recorder reads the harness's own event stream, out
// of band. A file the harness is already appending to is the most decoupled
// form of that: the harness needs no flag, no hook and no knowledge that
// anything is watching, and the stream survives this process dying — which
// `wrap` cannot claim, since killing the wrapper kills the child.
//
// Polled rather than `fs.watch`ed. `fs.watch` is the one Node API whose
// semantics genuinely differ per platform, and this project's own machines run
// WSL2, where inotify does not fire for writes made from the Windows side. A
// 200 ms poll on a file's size is boring, portable, and costs nothing next to
// what the agent it is watching is doing.
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

export interface TailOptions {
  /** Start at byte 0 rather than at the end. What you want for a finished transcript. */
  fromStart?: boolean;
  pollMs?: number;
}

export const DEFAULT_POLL_MS = 200;

/**
 * Reads whole lines as they appear, and hands back a stop function.
 *
 * A partial final line is held rather than delivered: the harness writes JSON
 * one object per line, and half an object is not an event. It is delivered on
 * the next poll that completes it, or dropped at stop — which is the same
 * judgement the spool makes about its own torn final line.
 */
export function tailFile(
  file: string,
  onLine: (line: string) => void,
  options: TailOptions = {},
): { stop: () => void; poll: () => void } {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  let offset = 0;
  let carry = "";
  let stopped = false;

  if (!options.fromStart && existsSync(file)) offset = statSync(file).size;

  const poll = (): void => {
    if (stopped || !existsSync(file)) return;
    const size = statSync(file).size;
    // A file that shrank was replaced — a new session writing to the same
    // path. Start over rather than reading from an offset that now points
    // into the middle of a different document.
    if (size < offset) {
      offset = 0;
      carry = "";
    }
    if (size === offset) return;

    const fd = openSync(file, "r");
    try {
      const length = size - offset;
      const buffer = Buffer.allocUnsafe(length);
      const read = readSync(fd, buffer, 0, length, offset);
      offset += read;
      const text = carry + buffer.subarray(0, read).toString("utf8");
      const parts = text.split("\n");
      // The last part is whatever came after the final newline: either an
      // empty string, or half a line still being written.
      carry = parts.pop() ?? "";
      for (const line of parts) onLine(line);
    } finally {
      closeSync(fd);
    }
  };

  // Deliberately **not** `unref`'d, and that is the whole liveness of `tail`.
  // It was, at first, on the reasoning that a poll loop should not keep a
  // process alive — which is exactly backwards here: following the file *is*
  // the work, and with the flush timer also unref'd there was nothing left
  // holding the event loop open. Node saw no pending handles, exited 0
  // immediately, and the recorder printed nothing and recorded nothing while
  // looking like a clean run. `stop()` clears it, which is what lets the
  // process end when the session really is over.
  const timer = setInterval(poll, pollMs);

  return {
    poll,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
