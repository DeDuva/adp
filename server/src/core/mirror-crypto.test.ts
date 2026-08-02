import { describe, it, expect } from "vitest";
import { encryptCredential, decryptCredential, redactUrl } from "./mirror-crypto.js";

describe("mirror-crypto", () => {
  it("round-trips a credential", () => {
    const ciphertext = encryptCredential("ghp_supersecrettoken", "test-key");
    expect(ciphertext).not.toContain("ghp_supersecrettoken");
    expect(decryptCredential(ciphertext, "test-key")).toBe("ghp_supersecrettoken");
  });

  it("fails to decrypt with the wrong key", () => {
    const ciphertext = encryptCredential("ghp_supersecrettoken", "test-key");
    expect(() => decryptCredential(ciphertext, "wrong-key")).toThrow();
  });

  it("fails to decrypt tampered ciphertext (auth tag)", () => {
    const ciphertext = encryptCredential("ghp_supersecrettoken", "test-key");
    const [iv, authTag, body] = ciphertext.split(":");
    const tampered = [iv, authTag, Buffer.from(body!, "base64").reverse().toString("base64")].join(":");
    expect(() => decryptCredential(tampered, "test-key")).toThrow();
  });

  it("redacts embedded credentials from URLs", () => {
    expect(redactUrl("https://x-access-token:ghp_abc123@github.com/o/r.git")).toBe(
      "https://<redacted>@github.com/o/r.git",
    );
    expect(redactUrl("no credential here")).toBe("no credential here");
  });
});
