import { createHash } from "node:crypto";
import * as ed25519 from "@noble/ed25519";

ed25519.etc.sha512Sync = (...messages: Uint8Array[]) => {
  const hash = createHash("sha512");
  for (const m of messages) hash.update(m);
  return new Uint8Array(hash.digest());
};

// Deterministic key derivation from the SIGNING_KEY env var so redeploying
// the same server (same env) reproduces the same identity. A dedicated
// per-agent-key story is explicitly deferred (docs/pragmatic_mvp.md §4.4 /
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
