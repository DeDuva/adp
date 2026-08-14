import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { identities, orgMemberships, tokens } from "../db/schema.js";

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
  // M4-1: which org this token is scoped to, if any. Null for every pre-M4
  // token and for one minted without an org — never defaulted to "the
  // identity's only org" or similar, because a token's org has to be an
  // explicit grant for requireOrgAccess (auth/plugin.ts) to fail closed.
  orgId: string | null;
  harness: string | null;
  model: string | null;
  sessionId: string | null;
}

export interface MintTokenOptions {
  expiresAt?: Date;
  harness?: string;
  model?: string;
  sessionId?: string;
  orgId?: string;
}

// `Pick` rather than `Db` so a transaction (`tx` inside `db.transaction()`)
// satisfies it too — http-rest/tokens.ts mints inside the same transaction
// that records the token.mint operation, same reasoning as
// core/org-lookup.ts's findOrCreateOrg.
export async function mintToken(
  db: Pick<Db, "insert">,
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
    orgId: opts.orgId ?? null,
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
      orgId: tokens.orgId,
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
    orgId: row.orgId,
    harness: row.harness,
    model: row.model,
    sessionId: row.sessionId,
  };
}

// M4-1: the integrity check requireOrgAccess (auth/plugin.ts) runs on every
// org-scoped request, not just at mint time — a token's own orgId says which
// org it was scoped to, but the identity could have been removed from that
// org since. Checking membership at request time is what makes "revoke this
// person's org access" actually revoke it, rather than only blocking new
// token mints.
export async function isOrgMember(db: Db, orgId: string, identityId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: orgMemberships.id })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.identityId, identityId)));
  return !!row;
}
