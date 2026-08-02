import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyGithubSignature } from "./mirror.js";

describe("verifyGithubSignature", () => {
  const body = '{"ref":"refs/heads/main","before":"a","after":"b"}';

  it("accepts a correctly signed payload", () => {
    const sig = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    expect(verifyGithubSignature("secret", body, sig)).toBe(true);
  });

  it("rejects a payload signed with the wrong secret", () => {
    const sig = `sha256=${createHmac("sha256", "wrong-secret").update(body).digest("hex")}`;
    expect(verifyGithubSignature("secret", body, sig)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const sig = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    expect(verifyGithubSignature("secret", body + "tampered", sig)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyGithubSignature("secret", body, undefined)).toBe(false);
  });
});
