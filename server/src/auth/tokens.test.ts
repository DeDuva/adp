import { describe, it, expect } from "vitest";
import { generateToken, hashToken, verifyTokenHash } from "./tokens.js";

describe("generateToken", () => {
  it("produces distinct, prefixed tokens", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).toMatch(/^adp_pat_/);
    expect(a).not.toBe(b);
  });
});

describe("hashToken / verifyTokenHash", () => {
  it("verifies the token that was hashed", () => {
    const token = generateToken();
    expect(verifyTokenHash(token, hashToken(token))).toBe(true);
  });

  it("rejects a different token", () => {
    const stored = hashToken(generateToken());
    expect(verifyTokenHash(generateToken(), stored)).toBe(false);
  });

  it("salts each hash independently", () => {
    const token = generateToken();
    expect(hashToken(token)).not.toBe(hashToken(token));
  });

  it("rejects a malformed stored hash instead of throwing", () => {
    expect(verifyTokenHash(generateToken(), "not-a-valid-hash")).toBe(false);
  });
});
