import { describe, it, expect } from "vitest";
import { KeyRegistry, Signer } from "./signing.js";
import { signStatement, verifyEnvelope, decodeStatement, type InTotoStatement } from "./dsse.js";

describe("DSSE envelopes", () => {
  const signer = new Signer("dsse-test-signing-key");

  function statement(): InTotoStatement {
    return {
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: "git+https://adp.example.com/acme/widget", digest: { sha1: "a".repeat(40) } }],
      predicateType: "https://adp.dev/gate-result/v1",
      predicate: { gate: "tests", status: "success" },
    };
  }

  it("signs a statement into an envelope with the payload type in every signature check", () => {
    const envelope = signStatement(signer, statement());
    expect(envelope.payloadType).toBe("application/vnd.in-toto+json");
    expect(envelope.signatures).toHaveLength(1);
    expect(envelope.signatures[0]!.keyid).toBe(signer.publicKeyHex);
  });

  it("round-trips the statement through base64 payload decoding", () => {
    const original = statement();
    const envelope = signStatement(signer, original);
    expect(decodeStatement(envelope)).toEqual(original);
  });

  it("verifies a genuine envelope", () => {
    const envelope = signStatement(signer, statement());
    expect(verifyEnvelope(signer, envelope)).toBe(true);
  });

  it("rejects an envelope whose payload was tampered with after signing", () => {
    const envelope = signStatement(signer, statement());
    const tamperedStatement = { ...statement(), predicate: { gate: "tests", status: "failure" } };
    const tampered = { ...envelope, payload: Buffer.from(JSON.stringify(tamperedStatement)).toString("base64") };
    expect(verifyEnvelope(signer, tampered)).toBe(false);
  });

  it("rejects an envelope signed by a different key", () => {
    const otherSigner = new Signer("a-completely-different-key");
    const envelope = signStatement(otherSigner, statement());
    expect(verifyEnvelope(signer, envelope)).toBe(false);
  });

  it("binds the payload type into the signature (PAE) — reusing the signature under a different type fails", () => {
    const envelope = signStatement(signer, statement());
    const retyped = { ...envelope, payloadType: "application/json" };
    expect(verifyEnvelope(signer, retyped)).toBe(false);
  });

  // #102: the rotation scenario keyid was written into envelopes to
  // survive, finally exercised. Old evidence verifies through a registry
  // that knows the retired key's PUBLIC half; the same evidence fails
  // against the new signer alone (which is the pre-#102 behavior and the
  // bug); an unknown keyid never falls through to the active key.
  it("evidence signed before a key rotation verifies through the registry, and only through it", () => {
    const oldSigner = new Signer("the-rotated-out-key");
    const newSigner = new Signer("the-key-after-rotation");
    const oldEvidence = signStatement(oldSigner, statement());

    const registry = new KeyRegistry(newSigner, [oldSigner.publicKeyHex]);
    expect(verifyEnvelope(registry, oldEvidence)).toBe(true);
    expect(verifyEnvelope(newSigner, oldEvidence)).toBe(false);

    // New evidence verifies too — the registry serves both generations.
    expect(verifyEnvelope(registry, signStatement(newSigner, statement()))).toBe(true);
  });

  it("an unknown keyid is a verification failure, never a fall-through to the active key", () => {
    const registry = new KeyRegistry(signer);
    const envelope = signStatement(signer, statement());
    const foreign = { ...envelope, signatures: [{ ...envelope.signatures[0]!, keyid: "f".repeat(64) }] };
    expect(verifyEnvelope(registry, foreign)).toBe(false);
  });

  it("a tampered payload fails even under the key that signed the original, registry or not", () => {
    const oldSigner = new Signer("the-rotated-out-key");
    const registry = new KeyRegistry(signer, [oldSigner.publicKeyHex]);
    const envelope = signStatement(oldSigner, statement());
    const tamperedStatement = { ...statement(), predicate: { gate: "tests", status: "failure" } };
    const tampered = { ...envelope, payload: Buffer.from(JSON.stringify(tamperedStatement)).toString("base64") };
    expect(verifyEnvelope(registry, tampered)).toBe(false);
  });
});
