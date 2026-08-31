import { describe, it, expect } from "vitest";
import { hashState } from "./sessions.js";

// The digest a checkpoint signs has to survive the round trip through the
// column that stores the state. `checkpoints.state` is `jsonb`, which sorts
// object keys by length and then bytewise and hands back what it sorted — so a
// digest over the caller's key order described a serialization the database
// never returns, and `resumeSession` refused the checkpoint at resume time.
describe("hashState is a digest of the state, not of one serialization of it", () => {
  it("does not depend on the order the caller wrote the keys in", () => {
    const written = { boundary: "final", harness: "codex", producer_id: "p", harness_session_id: "t-1" };
    const readBack = { harness: "codex", boundary: "final", producer_id: "p", harness_session_id: "t-1" };
    expect(hashState(written)).toBe(hashState(readBack));
  });

  it("sorts the way jsonb does, so a checkpoint that verifies today still does", () => {
    // Length first, then bytewise — not plain lexicographic, which would put
    // `aa` before `b` and reintroduce the mismatch in a new set of cases. The
    // value here is already in jsonb's order, so canonicalising must be a
    // no-op on its serialization.
    const jsonbOrder = { a: 1, bb: 2, harness: 3, boundary: 4, producer_id: 5 };
    expect(hashState(jsonbOrder)).toBe(
      hashState(JSON.parse('{"a":1,"bb":2,"harness":3,"boundary":4,"producer_id":5}')),
    );
    const plainLexicographic = { a: 1, bb: 2, boundary: 4, harness: 3, producer_id: 5 };
    expect(hashState(plainLexicographic)).toBe(hashState(jsonbOrder));
  });

  it("reaches into nested objects and through arrays", () => {
    expect(hashState({ outer: { bb: 1, a: 2 }, list: [{ zz: 1, y: 2 }] })).toBe(
      hashState({ outer: { a: 2, bb: 1 }, list: [{ y: 2, zz: 1 }] }),
    );
  });

  it("still tells different states apart", () => {
    // A canonical form that collapsed distinct values would be worse than the
    // bug: the digest would stop being evidence of anything.
    expect(hashState({ a: 1 })).not.toBe(hashState({ a: 2 }));
    expect(hashState({ a: 1 })).not.toBe(hashState({ b: 1 }));
    expect(hashState(["a", "b"])).not.toBe(hashState(["b", "a"]));
    expect(hashState(null)).not.toBe(hashState({}));
  });
});
