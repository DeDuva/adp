import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { identities, tokens } from "../db/schema.js";

const TOKEN_PREFIX = "adp_pat_";

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

// Deterministic, not secret on its own (scrypt+salt in tokenHash still does
// the real verification) — just narrows the row scan to O(1).
function lookupKeyFor(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Exported for unit testing; not part of the module's intended external API.
export function hashToken(token: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(token, salt, 64);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export function verifyTokenHash(token: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(token, salt, 64);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface AuthenticatedIdentity {
  identityId: string;
  kind: "human" | "agent";
  principal: string;
  scopes: string[];
  harness: string | null;
  model: string | null;
  sessionId: string | null;
}

export interface MintTokenOptions {
  expiresAt?: Date;
  harness?: string;
  model?: string;
  sessionId?: string;
}

export async function mintToken(
  db: Db,
  identityId: string,
  scopes: string[],
  opts: MintTokenOptions = {},
): Promise<string> {
  const token = generateToken();
  await db.insert(tokens).values({
    identityId,
    tokenHash: hashToken(token),
    lookupKey: lookupKeyFor(token),
    scopes,
    expiresAt: opts.expiresAt ?? null,
    harness: opts.harness ?? null,
    model: opts.model ?? null,
    sessionId: opts.sessionId ?? null,
  });
  return token;
}

// Keyed lookup by sha256(token) narrows this to (at most) one row — the
// scrypt verification against tokenHash is still what actually authenticates
// it; lookupKey just avoids scanning/scrypt-verifying every token in the table.
export async function authenticate(db: Db, token: string): Promise<AuthenticatedIdentity | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;

  const [row] = await db
    .select({
      tokenHash: tokens.tokenHash,
      scopes: tokens.scopes,
      revoked: tokens.revoked,
      expiresAt: tokens.expiresAt,
      harness: tokens.harness,
      model: tokens.model,
      sessionId: tokens.sessionId,
      identityId: identities.id,
      kind: identities.kind,
      principal: identities.principal,
    })
    .from(tokens)
    .innerJoin(identities, eq(tokens.identityId, identities.id))
    .where(and(eq(tokens.lookupKey, lookupKeyFor(token)), eq(tokens.revoked, false)));

  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  if (!verifyTokenHash(token, row.tokenHash)) return null;

  return {
    identityId: row.identityId,
    kind: row.kind as "human" | "agent",
    principal: row.principal,
    scopes: row.scopes,
    harness: row.harness,
    model: row.model,
    sessionId: row.sessionId,
  };
}
