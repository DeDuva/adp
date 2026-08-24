import { KeyRegistry, type Signer } from "./signing.js";

// DSSE (Dead Simple Signing Envelope, https://github.com/secure-systems-lab/dsse)
// wrapping an in-toto v1 attestation Statement. Chosen now per
// "choosing the envelope now is nearly
// free; converting stored evidence later is a migration."
export interface DsseEnvelope {
  payloadType: string;
  payload: string; // base64
  signatures: { keyid: string; sig: string }[];
}

export interface InTotoStatement {
  _type: "https://in-toto.io/Statement/v1";
  subject: { name: string; digest: Record<string, string> }[];
  predicateType: string;
  predicate: unknown;
}

const PAYLOAD_TYPE = "application/vnd.in-toto+json";

// DSSE Pre-Authentication Encoding: what actually gets signed, not the raw
// payload — binds the payload type into the signature so an envelope can't
// be reinterpreted as a different kind of statement.
// PAE(type, body) = "DSSEv1" + SP + len(type) + SP + type + SP + len(body) + SP + body
function pae(payloadType: string, payload: Buffer): Buffer {
  const typeBuf = Buffer.from(payloadType, "utf8");
  return Buffer.concat([
    Buffer.from("DSSEv1 ", "ascii"),
    Buffer.from(String(typeBuf.length), "ascii"),
    Buffer.from(" ", "ascii"),
    typeBuf,
    Buffer.from(" ", "ascii"),
    Buffer.from(String(payload.length), "ascii"),
    Buffer.from(" ", "ascii"),
    payload,
  ]);
}

export function signStatement(signer: Signer, statement: InTotoStatement): DsseEnvelope {
  const payload = Buffer.from(JSON.stringify(statement), "utf8");
  const signature = signer.signRaw(pae(PAYLOAD_TYPE, payload));
  return {
    payloadType: PAYLOAD_TYPE,
    payload: payload.toString("base64"),
    signatures: [{ keyid: signer.publicKeyHex, sig: Buffer.from(signature).toString("base64") }],
  };
}

// #102: `keyid` is finally read. A bare Signer keeps working (the
// single-key deployment), and a KeyRegistry resolves retired keys too — so
// evidence signed before a rotation verifies after it. An unknown keyid is
// a failure, never a fall-through to the active key.
export function verifyEnvelope(verifier: Signer | KeyRegistry, envelope: DsseEnvelope): boolean {
  const registry = verifier instanceof KeyRegistry ? verifier : new KeyRegistry(verifier);
  const payload = Buffer.from(envelope.payload, "base64");
  const message = pae(envelope.payloadType, payload);
  return envelope.signatures.some((s) => {
    const resolved = registry.resolve(s.keyid);
    return resolved !== null && resolved.verifyRaw(message, Buffer.from(s.sig, "base64"));
  });
}

export function decodeStatement(envelope: DsseEnvelope): InTotoStatement {
  return JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as InTotoStatement;
}
