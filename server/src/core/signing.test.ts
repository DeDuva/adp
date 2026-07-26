import { describe, it, expect } from "vitest";
import { Signer } from "./signing.js";

describe("Signer", () => {
  it("verifies a payload it signed", () => {
    const signer = new Signer("test-key");
    const payload = { b: 2, a: 1, nested: { z: 1, y: 2 } };
    const sig = signer.sign(payload);
    expect(signer.verify(payload, sig)).toBe(true);
  });

  it("is insensitive to key order (canonicalization)", () => {
    const signer = new Signer("test-key");
    const sig = signer.sign({ b: 2, a: 1, nested: { z: 1, y: 2 } });
    expect(signer.verify({ a: 1, nested: { y: 2, z: 1 }, b: 2 }, sig)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const signer = new Signer("test-key");
    const sig = signer.sign({ a: 1 });
    expect(signer.verify({ a: 999 }, sig)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const signerA = new Signer("key-a");
    const signerB = new Signer("key-b");
    const sig = signerA.sign({ a: 1 });
    expect(signerB.verify({ a: 1 }, sig)).toBe(false);
  });

  it("derives the same keypair deterministically from the same seed", () => {
    const a = new Signer("same-seed");
    const b = new Signer("same-seed");
    expect(a.publicKeyHex).toBe(b.publicKeyHex);
  });

  it("derives different keypairs from different seeds", () => {
    const a = new Signer("seed-one");
    const b = new Signer("seed-two");
    expect(a.publicKeyHex).not.toBe(b.publicKeyHex);
  });
});
