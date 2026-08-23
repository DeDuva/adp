import { createHash } from "node:crypto";
import * as ed25519 from "@noble/ed25519";

ed25519.etc.sha512Sync = (...messages: Uint8Array[]) => {
  const hash = createHash("sha512");
  for (const m of messages) hash.update(m);
  return new Uint8Array(hash.digest());
};

// Deterministic key derivation from the SIGNING_KEY env var so redeploying
// the same server (same env) reproduces the same identity. A dedicated
// per-agent-key story is explicitly deferred (
// cut list) — this is the server-held key the MVP calls for.
export class Signer {
  private readonly privateKey: Uint8Array;
  readonly publicKeyHex: string;

  constructor(signingKeySeed: string) {
    this.privateKey = new Uint8Array(createHash("sha256").update(signingKeySeed).digest());
    this.publicKeyHex = Buffer.from(ed25519.getPublicKey(this.privateKey)).toString("hex");
  }

  // Sorts object keys recursively so semantically-identical payloads always
  // produce the same bytes to sign, regardless of construction order.
  static canonicalize(value: unknown): string {
    return JSON.stringify(sortKeysDeep(value));
  }

  sign(payload: unknown): string {
    const message = new TextEncoder().encode(Signer.canonicalize(payload));
    const signature = ed25519.sign(message, this.privateKey);
    return Buffer.from(signature).toString("base64");
  }

  verify(payload: unknown, signatureBase64: string): boolean {
    const message = new TextEncoder().encode(Signer.canonicalize(payload));
    const signature = Buffer.from(signatureBase64, "base64");
    return ed25519.verify(signature, message, Buffer.from(this.publicKeyHex, "hex"));
  }

  // Signs exact bytes with no canonicalization/wrapping — DSSE (core/dsse.ts)
  // signs its own PAE-encoded byte string per spec, not arbitrary JSON.
  signRaw(message: Uint8Array): Uint8Array {
    return ed25519.sign(message, this.privateKey);
  }

  verifyRaw(message: Uint8Array, signature: Uint8Array): boolean {
    return ed25519.verify(signature, message, Buffer.from(this.publicKeyHex, "hex"));
  }
}

// A verification-only identity: a public key with no private half in this
// process — what a RETIRED key becomes after rotation, and the only form a
// second environment should ever hold another environment's key in.
export class PublicKeyVerifier {
  constructor(readonly publicKeyHex: string) {}

  verifyRaw(message: Uint8Array, signature: Uint8Array): boolean {
    return ed25519.verify(signature, message, Buffer.from(this.publicKeyHex, "hex"));
  }
}

export interface EnvelopeVerifier {
  publicKeyHex: string;
  verifyRaw(message: Uint8Array, signature: Uint8Array): boolean;
}

// #102: verification resolves the
// envelope's `keyid` through a registry instead of comparing against the
// single live signer. Before this, the first key rotation — or the first
// second environment — turned every already-signed piece of evidence into a
// verification failure: the whole point of writing `keyid` into envelopes
// was to survive exactly that, and nothing ever read it.
//
// The registry is the active signer plus retired PUBLIC keys
// (RETIRED_SIGNING_PUBLIC_KEYS). Retired keys can verify, never sign — a
// rotated-out key's evidence stays checkable forever without the old
// private key surviving anywhere.
export class KeyRegistry {
  private readonly byKeyId = new Map<string, EnvelopeVerifier>();

  constructor(active: Signer, retiredPublicKeysHex: string[] = []) {
    this.byKeyId.set(active.publicKeyHex, active);
    for (const hex of retiredPublicKeysHex) {
      const trimmed = hex.trim();
      if (trimmed) this.byKeyId.set(trimmed, new PublicKeyVerifier(trimmed));
    }
  }

  // Null for an unknown keyid — the caller treats that as verification
  // failure, never as "assume the active key": an envelope claiming a key
  // this instance has never heard of is precisely the forgery case.
  resolve(keyid: string): EnvelopeVerifier | null {
    return this.byKeyId.get(keyid) ?? null;
  }
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeysDeep(v)]),
    );
  }
  return value;
}
