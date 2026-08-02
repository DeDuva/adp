import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// AES-256-GCM at rest, keyed by the MIRROR_CREDENTIAL_KEY env var — same
// deterministic-key-from-env shape as Signer (core/signing.ts). Originally
// just mirror credentials (a GitHub PAT), now also used for the two
// webhook-signing secrets (core/webhooks.ts's secretCiphertext,
// http-rest/mirror-webhook.ts's webhookSecretCiphertext) — the function
// names stayed generic-by-accident and turned out generic-on-purpose. Not
// KMS/vault-grade (that's M4 multi-tenant hardening); the bar here is "no
// plaintext secret in a DB row or a log line".
function deriveKey(keySeed: string): Buffer {
  return createHash("sha256").update(keySeed).digest();
}

export function encryptCredential(plaintext: string, keySeed: string): string {
  const key = deriveKey(keySeed);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptCredential(stored: string, keySeed: string): string {
  const [ivB64, authTagB64, ciphertextB64] = stored.split(":");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("malformed mirror credential ciphertext");
  }
  const key = deriveKey(keySeed);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}

// Strips any embedded `user:token@` credential from a URL before it's safe
// to write to mirrorSyncLog.lastError or app logs.
export function redactUrl(url: string): string {
  return url.replace(/:\/\/[^/@]+@/, "://<redacted>@");
}
