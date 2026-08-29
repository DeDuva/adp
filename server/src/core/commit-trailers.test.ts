import { describe, it, expect } from "vitest";
import { asIntentUuid, asIssueNumber, asSessionUuid, noteToken, parseCommitTrailers } from "./commit-trailers.js";

const UUID = "9f3c1b7e-2a4d-4c5e-8f10-b2c3d4e5f607";

describe("parseCommitTrailers", () => {
  it("reads an intent trailer from the last paragraph", () => {
    const message = ["Clamp the retry backoff at 30s", "", "The exponential curve had no ceiling.", "", `ADP-Intent: ${UUID}`].join("\n");
    expect(parseCommitTrailers(message)).toEqual({ intent: UUID, session: null });
  });

  it("reads intent and session together", () => {
    const message = ["Do the thing", "", `ADP-Intent: #41`, `ADP-Session: ${UUID}`].join("\n");
    expect(parseCommitTrailers(message)).toEqual({ intent: "#41", session: UUID });
  });

  it("returns nothing for an ordinary message", () => {
    expect(parseCommitTrailers("Clamp the retry backoff at 30s")).toEqual({ intent: null, session: null });
  });

  it("returns nothing for an empty message", () => {
    expect(parseCommitTrailers("")).toEqual({ intent: null, session: null });
  });

  // The rule that keeps a commit from binding itself by talking about binding.
  it("ignores a trailer-shaped line that is not in the last paragraph", () => {
    const message = ["Explain the trailer", "", "Write ADP-Intent: 41 in the message.", "", "That is all."].join("\n");
    expect(parseCommitTrailers(message)).toEqual({ intent: null, session: null });
  });

  it("ignores a trailer block that has any non-trailer line in it", () => {
    const message = ["Do the thing", "", `ADP-Intent: ${UUID}`, "and some prose after it"].join("\n");
    expect(parseCommitTrailers(message)).toEqual({ intent: null, session: null });
  });

  it("coexists with other projects' trailers in the same block", () => {
    const message = ["Do the thing", "", "Signed-off-by: A Person <a@example.com>", `ADP-Intent: ${UUID}`, "Co-authored-by: B Person <b@example.com>"].join("\n");
    expect(parseCommitTrailers(message).intent).toBe(UUID);
  });

  it("matches the key case-insensitively", () => {
    expect(parseCommitTrailers("x\n\nadp-intent: 41").intent).toBe("41");
    expect(parseCommitTrailers("x\n\nADP-INTENT: 41").intent).toBe("41");
  });

  it("takes the last value when a key repeats, as git interpret-trailers does", () => {
    expect(parseCommitTrailers("x\n\nADP-Intent: 41\nADP-Intent: 42").intent).toBe("42");
  });

  it("treats a valueless trailer as absent", () => {
    expect(parseCommitTrailers("x\n\nADP-Intent:").intent).toBeNull();
    expect(parseCommitTrailers("x\n\nADP-Intent:   ").intent).toBeNull();
  });

  it("tolerates CRLF line endings and trailing blank lines", () => {
    expect(parseCommitTrailers(`Do the thing\r\n\r\nADP-Intent: 41\r\n\r\n\r\n`).intent).toBe("41");
  });

  it("reads a message that is nothing but a trailer", () => {
    expect(parseCommitTrailers(`ADP-Intent: ${UUID}`).intent).toBe(UUID);
  });

  it("leaves an unknown trailer key alone", () => {
    expect(parseCommitTrailers("x\n\nFix: the retry backoff")).toEqual({ intent: null, session: null });
  });
});

// These guard the boundary between a trailer and a query parameter. A token
// that is not shaped like a reference must never reach the database: Postgres
// rejects a malformed uuid with an error, and on the push path an error is a
// refused push.
describe("trailer token shapes", () => {
  it("accepts a uuid as an intent reference, normalised", () => {
    expect(asIntentUuid(UUID)).toBe(UUID);
    expect(asIntentUuid(UUID.toUpperCase())).toBe(UUID);
  });

  it("rejects anything that is not a uuid", () => {
    for (const token of ["", "41", "#41", "not-a-uuid", `${UUID}'; drop table changes; --`, `${UUID}x`]) {
      expect(asIntentUuid(token)).toBeNull();
    }
  });

  it("accepts an issue number with or without the hash", () => {
    expect(asIssueNumber("41")).toBe(41);
    expect(asIssueNumber("#41")).toBe(41);
  });

  it("rejects a non-number, a zero, and an implausibly long one", () => {
    for (const token of ["", "#", "0", "#0", "-1", "41x", "4 1", "1234567890", UUID]) {
      expect(asIssueNumber(token)).toBeNull();
    }
  });

  it("shapes a session reference like an intent uuid", () => {
    expect(asSessionUuid(UUID)).toBe(UUID);
    expect(asSessionUuid("#41")).toBeNull();
  });

  it("caps a token noted in the operation log", () => {
    const noted = noteToken("z".repeat(500));
    expect(noted).toHaveLength(101);
    expect(noted.endsWith("…")).toBe(true);
    expect(noteToken("#41")).toBe("#41");
  });
});
