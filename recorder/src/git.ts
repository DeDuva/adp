// What the working directory can tell us, and nothing more.
//
// The recorder is a pure HTTP client of ADP and has no repository access — but
// it runs *beside* the harness, in the checkout the harness is editing, and
// that checkout answers two questions nobody should have to be asked. Which
// intent is this work against: the `ADP-Intent` trailer on HEAD says so (#142).
// And has anything happened worth checkpointing: HEAD moving says so.
//
// **Every function here returns null rather than throwing**, and none of them
// is required for recording to work. The recorder is often started somewhere
// that is not a git repository at all — `wrap` from a scratch directory, a
// harness driven from elsewhere — and a session recorded without commit
// boundaries is a session recorded. A session lost because `git` was missing
// is not.
import { execFileSync } from "node:child_process";

/** Run git, quietly, and treat every failure as "this directory cannot answer". */
function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // A repository on a network mount, or one mid-rebase with an index lock,
      // must not hang the recorder's flush tick behind it.
      timeout: 5_000,
    }).trim();
  } catch {
    return null;
  }
}

/** The commit HEAD points at, or null outside a repository and on an unborn branch. */
export function headSha(dir: string): string | null {
  const sha = git(dir, ["rev-parse", "HEAD"]);
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** HEAD's full commit message, for the trailer the intent is named in. */
export function headMessage(dir: string): string | null {
  return git(dir, ["log", "-1", "--format=%B"]);
}

/**
 * The `ADP-Intent` trailer on HEAD, as written.
 *
 * Deliberately the same rule the server applies (`core/commit-trailers.ts`):
 * only the last blank-line-separated block counts, and only when every line in
 * it is trailer-shaped — so a commit body that *discusses* `ADP-Intent: 41` in
 * prose does not silently bind the session to intent 41. Duplicating twenty
 * lines of parser is the price of `recorder/` importing nothing from
 * `server/`; getting it subtly different would be worse than either.
 *
 * The value is returned raw — a UUID, `#41` or `41` — because resolving it
 * needs the repository, which is the caller's business.
 */
export function headIntentTrailer(dir: string): string | null {
  const message = headMessage(dir);
  if (!message) return null;

  const lines = message.replace(/\r\n/g, "\n").split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end--;
  if (end === 0) return null;
  let start = end;
  while (start > 0 && lines[start - 1]!.trim() !== "") start--;

  const block = lines.slice(start, end);
  const TRAILER = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/;
  if (!block.every((line) => TRAILER.test(line))) return null;

  let value: string | null = null;
  for (const line of block) {
    const match = TRAILER.exec(line)!;
    // Last value wins, matching `git interpret-trailers`.
    if (match[1]!.toLowerCase() === "adp-intent" && match[2]!.trim()) value = match[2]!.trim();
  }
  return value;
}
