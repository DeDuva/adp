// The transcript reader's assertions.
//
// This exists because `measurement.escapeHatchCalls` is meant to be read at a
// glance and acted on: it answers "did the agent fall back to raw HTTP after
// we gave it tools?", and a re-run's conclusion turns on it. A number nobody
// checks is a number nobody should trust, and the shell-splitting underneath
// it is exactly the kind of code that looks obviously right and is not — the
// first version counted `git log | grep curl` as a curl invocation.
import test from "node:test";
import assert from "node:assert/strict";
import { labelToolUse, parseAgentTranscript, programsIn } from "../lib/transcript.mjs";

const bash = (command) => ({ type: "tool_use", name: "Bash", input: { command } });
const assistant = (...blocks) => JSON.stringify({ type: "assistant", message: { content: blocks } });
const transcript = (...lines) => lines.join("\n");

test("labels a Bash call by the program it runs, not by 'Bash'", () => {
  assert.equal(labelToolUse(bash("git push origin work")), "Bash(git)");
  assert.equal(labelToolUse(bash("curl -s http://h/x")), "Bash(curl)");
  // Leading env assignments are part of the invocation, not the program.
  assert.equal(labelToolUse(bash("GH_HOST=h GH_TOKEN= gh pr create")), "Bash(gh)");
  // An absolute path is the same program.
  assert.equal(labelToolUse(bash("/usr/bin/curl -s x")), "Bash(curl)");
});

test("leaves non-Bash tools under their own names", () => {
  assert.equal(labelToolUse({ name: "Read" }), "Read");
  assert.equal(labelToolUse({ name: "mcp__adp-native__adp_proposal_open" }), "mcp__adp-native__adp_proposal_open");
  assert.equal(labelToolUse({}), "unknown");
});

test("splits a pipeline into the programs it actually runs", () => {
  assert.deepEqual(programsIn("npm test && curl -s x"), ["npm", "curl"]);
  assert.deepEqual(programsIn("git log | grep curl"), ["git", "grep"]);
  assert.deepEqual(programsIn("a; b || c"), ["a", "b", "c"]);
});

test("counts raw-HTTP invocations, not the substring 'curl'", () => {
  const count = (command) => parseAgentTranscript(assistant(bash(command))).escapeHatchCalls;

  assert.equal(count("curl -s http://h/x"), 1);
  assert.equal(count("SSL_CERT_FILE=/a/b curl -s x"), 1);
  assert.equal(count("npm test && curl -s -X POST http://h/x"), 1);
  assert.equal(count("curl a && curl b"), 2, "two invocations in one Bash call are two invocations");

  // The false positives the first version had. Each of these would have
  // reported a fallback that did not happen, on the one field meant to be
  // trustworthy.
  assert.equal(count("git log | grep curl"), 0, "grepping for the word is not a call");
  assert.equal(count("echo curling"), 0, "a substring is not a program");
  assert.equal(count("git commit -m 'use curl instead'"), 0, "nor is a commit message");

  // And the honest limit, asserted so it is a known gap rather than a
  // surprise: an agent with Bash(node *) can reach HTTP unseen. The per-tool
  // breakdown is what covers this — `Bash(node)` still shows up there.
  assert.equal(count("node -e \"fetch('http://h/x')\""), 0, "documented blind spot: node reaches HTTP unseen");
});

test("breaks tool use down per tool, sorted, alongside the totals", () => {
  const stdout = transcript(
    assistant(bash("git push origin work")),
    assistant({ type: "tool_use", name: "mcp__adp-native__adp_proposal_open" }),
    assistant(bash("curl -s http://h/x"), { type: "tool_use", name: "Read" }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", is_error: true }] } }),
    JSON.stringify({ type: "result", total_cost_usd: 0.13, permission_denials: [{}, {}] }),
  );

  const r = parseAgentTranscript(stdout);
  assert.equal(r.toolCalls, 4);
  assert.equal(r.toolErrors, 1);
  assert.equal(r.permissionDenials, 2);
  assert.equal(r.escapeHatchCalls, 1);
  assert.equal(r.finalResult.total_cost_usd, 0.13);
  // Sorted, so a diff between two run records is about what changed rather
  // than the order the agent happened to call things in.
  assert.deepEqual(Object.keys(r.toolBreakdown), [
    "Bash(curl)",
    "Bash(git)",
    "Read",
    "mcp__adp-native__adp_proposal_open",
  ]);
  assert.equal(r.toolBreakdown["Bash(curl)"], 1);
  // The breakdown must add up to the total, or one of the two is lying.
  assert.equal(
    Object.values(r.toolBreakdown).reduce((a, b) => a + b, 0),
    r.toolCalls,
  );
});

test("survives the noise a real transcript carries", () => {
  const r = parseAgentTranscript(
    transcript("", "not json at all", assistant(bash("git status")), "{malformed", JSON.stringify({ type: "system" })),
  );
  assert.equal(r.toolCalls, 1);
  assert.equal(r.finalResult, null);
  // No result event means no denials were reported — not that there were none.
  assert.equal(r.permissionDenials, 0);
});
