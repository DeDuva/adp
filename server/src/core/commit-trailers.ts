// Git trailers are how a pushed commit names the intent it answers.
//
// The alternative — `POST /api/v3/repos/{o}/{r}/changes` with an `intent_id`
// after the push — requires the agent to know its intent's UUID, make a second
// authenticated call, and be a harness that has been taught to. A trailer needs
// none of that: it rides on `git`, which every harness already speaks, so the
// binding works identically for Claude Code, Codex, a shell script and a human,
// and it survives a push from a machine that has never heard of ADP's REST
// surface (#142).
//
// **Which paragraph counts.** Only the last blank-line-separated block of the
// message is considered, and only when *every* line in it is trailer-shaped —
// git's own rule, and the reason a commit body that merely discusses
// `ADP-Intent: 41` in prose does not silently bind the change to intent 41.
export interface CommitTrailers {
  /** Raw `ADP-Intent` value as written — a UUID, `#41`, or `41`. Unresolved here. */
  intent: string | null;
  /** Raw `ADP-Session` value as written. Unresolved here. */
  session: string | null;
}

const EMPTY: CommitTrailers = { intent: null, session: null };

// `Key: value`, git's trailer shape. The key is deliberately narrow (no spaces)
// so an ordinary one-line subject like "Fix: the retry backoff" is still
// trailer-shaped and therefore harmless — it parses to a key nothing reads —
// while a subject containing a colon mid-sentence is not.
const TRAILER_LINE = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/;

/**
 * Parse ADP's trailers out of a commit message. Pure: no lookups, no
 * validation that anything named here exists. Resolution — and the repo
 * scoping that makes it safe — belongs to the caller.
 *
 * A key appearing more than once takes its last value, matching
 * `git interpret-trailers`.
 */
export function parseCommitTrailers(message: string): CommitTrailers {
  if (!message) return { ...EMPTY };

  const lines = message.replace(/\r\n/g, "\n").split("\n");

  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end--;
  if (end === 0) return { ...EMPTY };

  let start = end;
  while (start > 0 && lines[start - 1]!.trim() !== "") start--;

  const block = lines.slice(start, end);
  if (!block.every((line) => TRAILER_LINE.test(line))) return { ...EMPTY };

  const trailers: CommitTrailers = { ...EMPTY };
  for (const line of block) {
    const match = TRAILER_LINE.exec(line)!;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    // `ADP-Intent:` with nothing after it says nothing; treat it as absent
    // rather than as an unresolvable reference worth reporting.
    if (!value) continue;
    if (key === "adp-intent") trailers.intent = value;
    else if (key === "adp-session") trailers.session = value;
  }
  return trailers;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Bounded on purpose: this string reaches a query parameter, and `#` plus nine
// digits is more issue numbers than any repository will have.
const ISSUE_REF = /^#?(\d{1,9})$/;

/** A trailer value that could name an intent directly. */
export function asIntentUuid(token: string): string | null {
  return UUID.test(token) ? token.toLowerCase() : null;
}

/** A trailer value that could name an issue, whose intent the change inherits. */
export function asIssueNumber(token: string): number | null {
  const match = ISSUE_REF.exec(token);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** A trailer value that could name a session. */
export function asSessionUuid(token: string): string | null {
  return UUID.test(token) ? token.toLowerCase() : null;
}

// A trailer is written by whoever can push, so an unresolvable one is recorded
// as text in the operation log. Cap it: `ADP-Intent:` followed by a megabyte is
// a legal commit message.
const MAX_NOTED_TOKEN = 100;

export function noteToken(token: string): string {
  return token.length <= MAX_NOTED_TOKEN ? token : `${token.slice(0, MAX_NOTED_TOKEN)}…`;
}
