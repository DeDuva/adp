import { describe, it, expect } from "vitest";
import {
  formatCost,
  formatDuration,
  formatTokens,
  isProjectedString,
  payloadIsProjected,
  payloadPreview,
  runArm,
  sessionVerdict,
  shortSha,
  verificationBadge,
} from "./format.js";
import type { RunVerification, TrajectoryEvent, VerifySession } from "./api.js";

const session = (over: Partial<VerifySession> = {}): VerifySession => ({
  session_id: "s1",
  ok: true,
  event_count: 10,
  head: "abc",
  broke_at_seq: null,
  reason: null,
  emitter_tracked: false,
  emitter_complete: true,
  emitter_first_gap: null,
  verified_from_seq: 0,
  verified_to_seq: 10,
  prefix: "recomputed",
  attested_heads_checked: 0,
  anchor: null,
  ...over,
});

const verification = (over: Partial<RunVerification> = {}): RunVerification => ({
  run_id: "r1",
  ok: true,
  coverage: "full",
  chains_ok: true,
  emitters_ok: true,
  envelope_verified: true,
  trajectory_digest_matches: true,
  recomputed_trajectory_digest: "d",
  attested_trajectory_digest: "d",
  final_git_sha: "f",
  attested_subject_sha: "f",
  sessions: [session()],
  ...over,
});

describe("formatCost", () => {
  // The reason cost is stored in micro-USD at all: per-event cost is far below
  // a cent, and rendering it as $0.00 would make the column useless for exactly
  // the comparison it exists for.
  it("never rounds a nonzero cost away", () => {
    expect(formatCost(12)).toBe("$0.0000");
    expect(formatCost(1200)).toBe("$0.0012");
    expect(formatCost(0)).toBe("$0");
  });

  it("widens the precision as the number grows", () => {
    expect(formatCost(50_000)).toBe("$0.050");
    expect(formatCost(1_500_000)).toBe("$1.50");
  });

  it("distinguishes unmeasured from zero", () => {
    expect(formatCost(null)).toBe("—");
    expect(formatCost(0)).not.toBe("—");
  });
});

describe("formatDuration", () => {
  it("scales its unit", () => {
    expect(formatDuration(400)).toBe("400ms");
    expect(formatDuration(4500)).toBe("4.5s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(7_500_000)).toBe("2h 5m");
  });

  it("distinguishes unmeasured from zero", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(0)).toBe("0ms");
  });
});

describe("formatTokens and shortSha", () => {
  it("abbreviates only above a thousand", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(2400)).toBe("2.4k");
    expect(formatTokens(null)).toBe("—");
  });

  it("shortens a sha and says nothing for an absent one", () => {
    expect(shortSha("0123456789abcdef")).toBe("01234567");
    expect(shortSha(null)).toBe("—");
  });
});

// #156 is explicit that these must not collapse: "Verified" and "nothing was
// dropped" are different assurances and one green tick throws away the more
// interesting half.
describe("verificationBadge keeps the two answers apart", () => {
  it("reports a chain that verifies while events are missing", () => {
    const badge = verificationBadge(
      verification({
        emitters_ok: false,
        sessions: [session({ emitter_tracked: true, emitter_complete: false, emitter_first_gap: 7 })],
      }),
    );
    expect(badge.chains.tone).toBe("ok");
    expect(badge.emitters.tone).toBe("bad");
    expect(badge.tone).toBe("bad");
  });

  it("reports events delivered whole while the chain is broken", () => {
    const badge = verificationBadge(
      verification({ chains_ok: false, sessions: [session({ emitter_tracked: true, ok: false })] }),
    );
    expect(badge.chains.tone).toBe("bad");
    expect(badge.emitters.tone).toBe("ok");
  });

  // An emitter that never claimed completeness has not failed to deliver it.
  // Colouring that red is how a badge teaches people to ignore it.
  it("calls an untracked emitter unknown, not incomplete", () => {
    const badge = verificationBadge(verification());
    expect(badge.emitters.tone).toBe("unknown");
    expect(badge.emitters.label).toMatch(/no emitter counted/);
    expect(badge.tone).toBe("warn");
  });

  it("separates an unverifiable signature from a mismatched digest", () => {
    expect(verificationBadge(verification({ envelope_verified: false })).attestation.label).toMatch(/signature/);
    expect(verificationBadge(verification({ trajectory_digest_matches: false })).attestation.label).toMatch(/digest/);
    expect(verificationBadge(verification({ envelope_verified: null })).attestation.tone).toBe("unknown");
  });

  // A run verified from a checkpoint has had less of it recomputed, and the
  // badge says so rather than presenting the weaker answer as the strong one.
  it("says when a chain was verified from a signed checkpoint rather than the start", () => {
    const badge = verificationBadge(
      verification({
        coverage: "from-checkpoint",
        sessions: [session({ prefix: "attested", verified_from_seq: 12 }), session()],
      }),
    );
    expect(badge.partial).toMatch(/1 of 2 chains verified from a signed checkpoint/);
    expect(verificationBadge(verification()).partial).toBeNull();
  });
});

describe("sessionVerdict", () => {
  it("says how much was checked, not merely that it passed", () => {
    expect(sessionVerdict(session())).toBe("10 events verified from the start");
    expect(sessionVerdict(session({ prefix: "attested", verified_from_seq: 12, verified_to_seq: 20 }))).toBe(
      "20 events verified from event 12",
    );
  });

  it("names the missing number as well as the verification", () => {
    expect(
      sessionVerdict(session({ emitter_tracked: true, emitter_complete: false, emitter_first_gap: 7 })),
    ).toMatch(/missing from 7/);
  });

  it("prefers the failure's own reason over a generic one", () => {
    expect(sessionVerdict(session({ ok: false, reason: "event 4 does not match its recorded hash" }))).toBe(
      "event 4 does not match its recorded hash",
    );
  });
});

const event = (payload: unknown, over: Partial<TrajectoryEvent> = {}): TrajectoryEvent =>
  ({ payload, payload_digest: null, ...over }) as TrajectoryEvent;

describe("payloadPreview renders client-side without the server parsing anything", () => {
  it("finds the human-readable field a harness used", () => {
    expect(payloadPreview(event({ text: "ran the tests" }))).toBe("ran the tests");
    expect(payloadPreview(event({ command: "npm test" }))).toBe("npm test");
  });

  it("falls back to the shape rather than throwing", () => {
    expect(payloadPreview(event({ a: 1, b: 2 }))).toBe("{ a, b }");
    expect(payloadPreview(event({}))).toBe("{}");
    expect(payloadPreview(event(null))).toBe("—");
    expect(payloadPreview(event(42))).toBe("42");
  });

  it("flattens whitespace and truncates", () => {
    expect(payloadPreview(event({ text: "a\n\n  b" }))).toBe("a b");
    expect(payloadPreview(event({ text: "x".repeat(200) }), 10)).toBe(`${"x".repeat(9)}…`);
  });

  // #199: under the default policy the strings are already gone, replaced by a
  // marker. A reader has to be able to tell "this is all there was" from "this
  // is what is left of it".
  it("marks a payload stored as structure", () => {
    expect(payloadIsProjected(event({ text: "[adp:str bytes=12]" }, { payload_digest: "abc" }))).toBe(true);
    expect(payloadIsProjected(event({ text: "hi" }))).toBe(false);
  });

  // And never renders the marker as though the agent had said it. It reads as
  // content, it is identical on every row, and it crowds out the columns that
  // do still say what happened.
  it("falls through to the shape rather than showing the projection marker", () => {
    expect(payloadPreview(event({ text: "[adp:str bytes=21]" }, { payload_digest: "d" }))).toBe("{ text }");
    expect(payloadPreview(event({ command: "[adp:str bytes=8]", exit: 1 }, { payload_digest: "d" }))).toBe(
      "{ command, exit }",
    );
    expect(payloadPreview(event("[adp:str bytes=4]", { payload_digest: "d" }))).toBe("(text not retained)");
    expect(isProjectedString("[adp:str bytes=99]")).toBe(true);
    expect(isProjectedString("adp:str bytes=99")).toBe(false);
  });

  // A repo on `payloads: full` still shows what was said, which is the whole
  // reason the distinction is worth drawing.
  it("still shows real content when the repo stores payloads in full", () => {
    expect(payloadPreview(event({ text: "ran the tests" }))).toBe("ran the tests");
  });
});

describe("runArm", () => {
  it("reads the arm off the signed labels", () => {
    expect(runArm({ provider: "anthropic", model: "claude-opus-5" })).toBe("anthropic · claude-opus-5");
    expect(runArm({ harness: "claude-code", provider: "anthropic", model: "x" })).toBe("claude-code · anthropic · x");
  });

  it("says nothing rather than guessing when a run carries no labels", () => {
    expect(runArm({})).toBe("—");
  });
});
