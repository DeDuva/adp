import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { structureEventPayloads, structureMarker, structurePayload } from "./trajectory-structure.js";
import { canonicalJson } from "./canonical.js";

describe("#199: the trajectory payload default", () => {
  it("keeps the payload's shape and drops the string content", () => {
    // The claim the default rests on: what a reader loses is the content, not
    // the ability to see what the agent did. This payload is a format ADP has
    // never seen, and nothing here branches on it.
    const { value } = structurePayload({
      tool: "read_file",
      args: { path: "src/secrets.ts" },
      output: "the entire file, which is the thing not to keep",
      exit_code: 0,
      truncated: false,
      cursor: null,
      lines: ["one", "two"],
    });

    expect(value).toEqual({
      tool: "[adp:str bytes=9]",
      args: { path: "[adp:str bytes=14]" },
      output: "[adp:str bytes=47]",
      // Numbers, booleans and null are structure, and survive as themselves.
      exit_code: 0,
      truncated: false,
      cursor: null,
      lines: ["[adp:str bytes=3]", "[adp:str bytes=3]"],
    });
  });

  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    // Bytes are the unit #146's ceilings speak, and the only one a verifier
    // that is not JavaScript reproduces.
    expect(structureMarker("é")).toBe("[adp:str bytes=2]");
    expect(structureMarker("🙂")).toBe("[adp:str bytes=4]");
    expect(structureMarker("")).toBe("[adp:str bytes=0]");
  });

  it("digests the payload as supplied, canonically", () => {
    // The commitment half of "verified, payload not retained": a producer
    // holding its own copy can prove the record corresponds to it.
    const payload = { b: "second", a: "first" };
    const { digest } = structurePayload(payload);
    expect(digest).toBe(createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex"));

    // Canonical, so the key order the harness happened to build in cannot
    // change what was committed to.
    expect(structurePayload({ a: "first", b: "second" }).digest).toBe(digest);
    // And it is a commitment to *this* payload — one different byte, one
    // different digest.
    expect(structurePayload({ a: "first", b: "secons" }).digest).not.toBe(digest);
  });

  it("is not reversible: two payloads of the same shape and lengths share a projection", () => {
    const a = structurePayload({ prompt: "aaaaaaa" });
    const b = structurePayload({ prompt: "bbbbbbb" });
    expect(a.value).toEqual(b.value);
    // Which is why the digest is what distinguishes them, and why it has to be
    // covered by the chain rather than stored beside it as a hint.
    expect(a.digest).not.toBe(b.digest);
  });

  it("is far smaller than what it replaces, for the payloads this table actually holds", () => {
    // The storage analysis measured a mean of 833 B/event, dominated by prose.
    // A default that grew the common case is not a default anyone keeps, which
    // is why the digest is taken once over the payload rather than per leaf.
    const payload = { role: "assistant", text: "x".repeat(4000) };
    const before = JSON.stringify(payload).length;
    const after = JSON.stringify(structurePayload(payload).value).length;
    expect(after).toBeLessThan(before / 20);
  });

  it("leaves a payload-less event alone, and claims no digest over it", () => {
    // There is nothing not retained, so a digest would be evidence about an
    // absence dressed up as evidence about a payload — and the event has to go
    // on hashing exactly as it does today.
    const { events, digests } = structureEventPayloads([
      { kind: "message" },
      { kind: "message", payload: null },
      { kind: "message", payload: { text: "hi" } },
    ] as { kind: string; payload?: unknown }[]);

    expect(digests[0]).toBeNull();
    expect(digests[1]).toBeNull();
    expect(digests[2]).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(events[0]).toEqual({ kind: "message" });
    expect(events[1]).toEqual({ kind: "message", payload: null });
    expect(events[2]!.payload).toEqual({ text: "[adp:str bytes=2]" });
  });

  it("keeps every other field of the event untouched", () => {
    // The typed columns are where "what did the agent do" is actually
    // answered, and this must not be the thing that edits them.
    const { events } = structureEventPayloads([
      { kind: "tool_call", type: "Bash", status: "failure", client_event_id: "evt-1", payload: { cmd: "ls" } },
    ]);
    expect(events[0]).toEqual({
      kind: "tool_call",
      type: "Bash",
      status: "failure",
      client_event_id: "evt-1",
      payload: { cmd: "[adp:str bytes=2]" },
    });
  });
});
