import { describe, it, expect } from "vitest";
import { canonicalJson } from "./canonical.js";
import { chainGenesis, eventHash } from "./trajectory.js";
import { trajectoryDigest, type SessionChain } from "./runs.js";
import { specDigest } from "./evals.js";

function event(overrides: Partial<Parameters<typeof eventHash>[2]> = {}) {
  return {
    seq: 1,
    kind: "tool_call",
    type: "Bash",
    payload: { command: "npm test" },
    status: "success" as string | null,
    model: null,
    tokensIn: null,
    tokensOut: null,
    costMicroUsd: null,
    durationMs: 120,
    gitSha: null,
    relatedSessionId: null,
    occurredAt: new Date("2026-08-04T10:00:00.000Z"),
    ...overrides,
  };
}

describe("canonicalJson", () => {
  it("is independent of key insertion order at every depth", () => {
    const a = { b: 1, a: { d: [1, { z: 1, y: 2 }], c: 3 } };
    const b = { a: { c: 3, d: [1, { y: 2, z: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("keeps array order, because in an array order is content", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("does not flatten values that serialize through toJSON", () => {
    expect(canonicalJson({ at: new Date("2026-08-04T10:00:00.000Z") })).toBe('{"at":"2026-08-04T10:00:00.000Z"}');
  });

  it("treats an explicit undefined property as absent, matching JSON.stringify", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("eventHash", () => {
  const session = "11111111-1111-1111-1111-111111111111";
  const other = "22222222-2222-2222-2222-222222222222";

  it("is stable across payload key ordering", () => {
    const one = eventHash(session, "prev", event({ payload: { a: 1, b: 2 } }));
    const two = eventHash(session, "prev", event({ payload: { b: 2, a: 1 } }));
    expect(one).toBe(two);
  });

  it("binds the session, so a sequence cannot be replayed into another session", () => {
    expect(eventHash(session, "prev", event())).not.toBe(eventHash(other, "prev", event()));
  });

  it("binds the predecessor, so reordering breaks the chain", () => {
    expect(eventHash(session, "a", event())).not.toBe(eventHash(session, "b", event()));
  });

  // The projection columns are the ones an analyst reads and a policy might act
  // on. If the hash only covered `payload`, they could be rewritten without
  // detection while the chain still verified — which is worse than not hashing.
  it.each([
    ["kind", { kind: "message" }],
    ["type", { type: "Read" }],
    ["status", { status: "failure" }],
    ["model", { model: "claude-opus-5" }],
    ["tokensIn", { tokensIn: 10 }],
    ["tokensOut", { tokensOut: 10 }],
    ["costMicroUsd", { costMicroUsd: 5 }],
    ["durationMs", { durationMs: 121 }],
    ["gitSha", { gitSha: "a".repeat(40) }],
    ["relatedSessionId", { relatedSessionId: other }],
    ["seq", { seq: 2 }],
    ["occurredAt", { occurredAt: new Date("2026-08-04T10:00:01.000Z") }],
  ])("covers %s", (_name, override) => {
    expect(eventHash(session, "prev", event(override))).not.toBe(eventHash(session, "prev", event()));
  });

  it("distinguishes an absent field from a null one only where JSON does", () => {
    // `status: undefined` and `status: null` are the same event — the column is
    // nullable and an emitter omitting it means the same as sending null.
    expect(eventHash(session, "p", event({ status: undefined as unknown as null }))).toBe(
      eventHash(session, "p", event({ status: null })),
    );
  });
});

describe("chainGenesis", () => {
  it("differs per session", () => {
    expect(chainGenesis("a")).not.toBe(chainGenesis("b"));
  });
});

describe("trajectoryDigest", () => {
  const chains: SessionChain[] = [
    { sessionId: "bbbb", harness: "claude-code", count: 3, head: "h2" },
    { sessionId: "aaaa", harness: "openhands", count: 5, head: "h1" },
  ];

  it("does not depend on the order sessions came back from the database", () => {
    expect(trajectoryDigest(chains)).toBe(trajectoryDigest([...chains].reverse()));
  });

  it("changes when any session's head moves", () => {
    const moved = chains.map((c) => (c.sessionId === "aaaa" ? { ...c, head: "h1'" } : c));
    expect(trajectoryDigest(moved)).not.toBe(trajectoryDigest(chains));
  });

  it("changes when a session is added, so a dropped session is not invisible", () => {
    expect(trajectoryDigest([...chains, { sessionId: "cccc", harness: "x", count: 0, head: "g" }])).not.toBe(
      trajectoryDigest(chains),
    );
  });
});

describe("specDigest", () => {
  it("is order-independent, so an eval config is identified by content", () => {
    expect(specDigest({ suite: "unit", cases: 12 })).toBe(specDigest({ cases: 12, suite: "unit" }));
  });

  it("separates two different eval definitions", () => {
    expect(specDigest({ suite: "unit", cases: 12 })).not.toBe(specDigest({ suite: "unit", cases: 13 }));
  });
});
