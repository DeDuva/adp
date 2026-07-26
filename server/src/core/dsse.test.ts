import { describe, it, expect } from "vitest";
import { Signer } from "./signing.js";
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
});
