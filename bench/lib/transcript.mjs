// Reading an agent transcript: what the agent did, not just how much it cost.
//
// This lives in `lib/` rather than inside `arms/three-way-cost.mjs` for the
// same reason `merge-contention.mjs` does — the arm scripts run `main()` on
// import, so anything that needs a test has to sit beside them rather than in
// them. `bench/test/transcript.test.mjs` drives this module directly, so the
// code the tests check is the code the arm runs.
//
// A bare `toolCalls` total says how much an interface cost in round trips and
// nothing about which interface was used. That was fine while each arm had
// exactly one way to reach the forge; it stopped being fine when the adp-mcp
// arm kept a `curl` escape hatch open on purpose. A fallback that is allowed
// but invisible is the worst of both — the number moves and the record does
// not say why.
import path from "node:path";

// The program a shell segment actually runs. Leading `VAR=value` assignments
// are part of the invocation, not the program, so `GH_HOST=… gh pr create`
// resolves to gh.
export function programOf(segment) {
  const words = String(segment).trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  return path.basename(words[0] ?? "").replace(/[^A-Za-z0-9_.-]/g, "");
}

// One Bash call can be a whole pipeline. Splitting on the operators that start
// a new command is what lets `npm test && curl …` be seen as two programs
// rather than one, and — more importantly — keeps `git log | grep curl` from
// reading as a curl invocation, which a substring search does.
const SHELL_SEPARATORS = /(?:&&|\|\||[;|&()\n])/;

export function programsIn(command) {
  return String(command).split(SHELL_SEPARATORS).map(programOf).filter(Boolean);
}

// Bash calls are labelled by the command they ran, MCP calls keep their own
// names, and everything else keeps its tool name. `Bash(git)` and `Bash(curl)`
// are different facts about a trial.
export function labelToolUse(block) {
  if (block.name !== "Bash") return block.name ?? "unknown";
  return `Bash(${programOf(block.input?.command ?? "") || "?"})`;
}

// Deliberately separate from the breakdown, and deliberately conservative.
// This is the one signal a re-run has to be able to read at a glance — "did
// the agent fall back to raw HTTP after we gave it tools?" — and burying it
// inside a generic per-tool map would repeat the mistake of burying it inside
// a total.
//
// It counts invocations, so a curl behind an `&&` counts and a `grep curl`
// does not. It is a signal and not a proof: an agent holding `Bash(node *)`
// could reach HTTP through `node -e` and this would not see it. That is
// exactly why the full breakdown ships beside it rather than instead of it —
// the breakdown shows the whole shape, this shows the one thing a reader is
// looking for.
export const ESCAPE_HATCH_PROGRAMS = new Set(["curl", "wget", "http", "httpie"]);

export function parseAgentTranscript(stdout) {
  let toolCalls = 0;
  let toolErrors = 0;
  let permissionDenials = 0;
  let escapeHatchCalls = 0;
  let finalResult = null;
  const toolBreakdown = {};
  for (const line of String(stdout).split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type !== "tool_use") continue;
        toolCalls++;
        const label = labelToolUse(block);
        toolBreakdown[label] = (toolBreakdown[label] ?? 0) + 1;
        if (block.name === "Bash") {
          escapeHatchCalls += programsIn(block.input?.command ?? "").filter((p) => ESCAPE_HATCH_PROGRAMS.has(p)).length;
        }
      }
    } else if (event.type === "user") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_result" && block.is_error) toolErrors++;
      }
    } else if (event.type === "result") {
      finalResult = event;
      permissionDenials = (event.permission_denials ?? []).length;
    }
  }
  // Sorted, so a diff between two run records is about what changed rather
  // than about what order the agent happened to call things in. By code unit
  // rather than `localeCompare`: locale-aware ordering depends on the ICU data
  // of the machine that ran the trial, so it would reorder `Read` against
  // `mcp__…` between two otherwise identical runs — a diff about nothing, in
  // the one field that exists to make diffs meaningful.
  const sorted = Object.fromEntries(Object.entries(toolBreakdown).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { toolCalls, toolErrors, permissionDenials, escapeHatchCalls, toolBreakdown: sorted, finalResult };
}
