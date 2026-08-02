import { describe, it, expect } from "vitest";
import { parseFlags, splitRepo } from "../src/args.js";

describe("parseFlags", () => {
  it("parses --key value pairs", () => {
    expect(parseFlags(["--server", "http://x", "--token", "abc"])).toEqual({
      server: "http://x",
      token: "abc",
    });
  });

  it("treats a flag with no following value as a boolean 'true'", () => {
    expect(parseFlags(["--active"])).toEqual({ active: "true" });
  });

  it("treats a flag immediately followed by another flag as boolean", () => {
    expect(parseFlags(["--active", "--server", "http://x"])).toEqual({
      active: "true",
      server: "http://x",
    });
  });

  it("ignores positional (non-flag) arguments", () => {
    expect(parseFlags(["acme/widget", "--repo", "acme/widget"])).toEqual({ repo: "acme/widget" });
  });
});

describe("splitRepo", () => {
  it("splits owner/repo", () => {
    expect(splitRepo("acme/widget")).toEqual({ owner: "acme", repo: "widget" });
  });

  it("throws on a malformed value", () => {
    expect(() => splitRepo("widget")).toThrow(/owner.*repo/i);
    expect(() => splitRepo("")).toThrow(/owner.*repo/i);
  });
});
