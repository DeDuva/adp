import { describe, it, expect } from "vitest";
import { toGlobalId, fromGlobalId } from "./global-id.js";

describe("global IDs", () => {
  it("round-trips typeName and internalId", () => {
    const gid = toGlobalId("Repository", "abc-123");
    expect(fromGlobalId(gid)).toEqual({ typeName: "Repository", internalId: "abc-123" });
  });

  it("is real base64 of 'TypeName:id', matching GitHub's shape", () => {
    const gid = toGlobalId("Issue", "42");
    expect(Buffer.from(gid, "base64").toString("utf8")).toBe("Issue:42");
  });

  it("returns null for garbage input", () => {
    expect(fromGlobalId("not-valid-base64!!!")).toBeNull();
  });

  it("returns null when the decoded value has no separator", () => {
    const noSep = Buffer.from("nocolonhere", "utf8").toString("base64");
    expect(fromGlobalId(noSep)).toBeNull();
  });
});
