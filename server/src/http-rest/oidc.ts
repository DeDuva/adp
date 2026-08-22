// M4-5: the OIDC authorization-code flow, mapped onto `identities`.
//
// Two routes and one decision. `/auth/oidc/start` begins the flow;
// `/auth/oidc/callback` finishes it and mints a token. The decision — may this
// verified person have a token at all? — is `resolveIdentity` below, and it
// fails closed: a login by someone with no existing link is refused unless
// their verified email domain was explicitly allowed by an operator.
//
// The flow state (state, nonce, PKCE verifier) rides in one httpOnly cookie
// under an HMAC, rather than in a table. A row per in-flight login would be a
// table whose only job is to be garbage-collected, and the browser is the one
// party that must hold this state anyway — binding it to the browser is the
// point of `state`. The HMAC is what stops the browser editing it.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { externalIdentities, identities, orgMemberships } from "../db/schema.js";
import { mintToken } from "../auth/tokens.js";
import { recordOperation } from "../core/operations.js";
import { OidcError, OidcProvider, pkceChallengeFor, safeEqual } from "../core/oidc.js";

const FLOW_COOKIE = "adp_oidc_flow";
// The whole flow is a redirect out and a redirect back. Ten minutes is
// generous for a human at a consent screen and short enough that an abandoned
// flow's cookie is worthless long before anyone finds it.
const FLOW_TTL_MS = 600_000;

// A login mints exactly these. `admin` is not reachable here by any input,
// for the same reason POST /api/adp/tokens bounds its own enum (#90): a
// credential path that can escalate is one bug away from being the only bug
// that matters. Creating an admin stays a host-level operator action.
const LOGIN_SCOPES = ["repo:read", "repo:write"] as const;

export interface OidcConfig {
  issuer: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  allowedDomains: string[];
  tokenTtlMinutes: number;
  publicUrl: string;
  // Derived from SIGNING_KEY by the caller — used only to authenticate the
  // flow cookie, never to sign anything that leaves this server.
  cookieKey: Buffer;
}

interface FlowState {
  state: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
}

function sealFlow(flow: FlowState, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(flow), "utf8").toString("base64url");
  const mac = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function openFlow(sealed: string, key: Buffer): FlowState | null {
  const [body, mac] = sealed.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", key).update(body).digest("base64url");
  const a = Buffer.from(mac, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const flow = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as FlowState;
    if (typeof flow.state !== "string" || typeof flow.nonce !== "string") return null;
    if (typeof flow.verifier !== "string" || typeof flow.expiresAt !== "number") return null;
    if (flow.expiresAt < Date.now()) return null;
    return flow;
  } catch {
    return null;
  }
}

function setFlowCookie(reply: FastifyReply, value: string, secure: boolean): void {
  const attrs = [
    `${FLOW_COOKIE}=${value}`,
    "Path=/auth/oidc",
    "HttpOnly",
    // Lax, not Strict: the callback arrives as a top-level GET navigation from
    // the issuer, and Strict would withhold the cookie on exactly that request
    // — the flow would fail every time, in a way that looks like a CSRF check
    // working.
    "SameSite=Lax",
    `Max-Age=${Math.floor(FLOW_TTL_MS / 1000)}`,
  ];
  if (secure) attrs.push("Secure");
  reply.header("Set-Cookie", attrs.join("; "));
}

function clearFlowCookie(reply: FastifyReply, secure: boolean): void {
  const attrs = [`${FLOW_COOKIE}=`, "Path=/auth/oidc", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  reply.header("Set-Cookie", attrs.join("; "));
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

export interface ResolvedLogin {
  identityId: string;
  principal: string;
  created: boolean;
}

// The admission decision, kept separate from the routes so it can be tested
// as what it is: a policy, not a handler.
//
// Order matters. An existing link wins outright — an operator who pre-linked
// someone has already decided, and a later narrowing of the domain allowlist
// should not silently lock out people who already have accounts. Only an
// *unknown* subject is subject to the allowlist, and with no allowlist
// configured there is no path that creates an identity.
export async function resolveIdentity(
  db: Db,
  claims: { iss: string; sub: string; email?: string; email_verified?: boolean; name?: string },
  allowedDomains: string[],
): Promise<ResolvedLogin> {
  const [link] = await db
    .select({ id: externalIdentities.id, identityId: externalIdentities.identityId })
    .from(externalIdentities)
    .where(
      and(eq(externalIdentities.issuer, claims.iss), eq(externalIdentities.subject, claims.sub)),
    );

  if (link) {
    const [identity] = await db
      .select({ principal: identities.principal })
      .from(identities)
      .where(eq(identities.id, link.identityId));
    await db
      .update(externalIdentities)
      .set({ email: claims.email ?? null, lastLoginAt: new Date() })
      .where(eq(externalIdentities.id, link.id));
    return {
      identityId: link.identityId,
      principal: identity?.principal ?? claims.sub,
      created: false,
    };
  }

  if (allowedDomains.length === 0) {
    throw new OidcError(
      "no identity is linked to this account, and auto-provisioning is disabled",
    );
  }
  // Auto-provisioning keys on the email domain, so an unverified email cannot
  // be used to claim one. Google sets email_verified false for some account
  // types, and treating absent as verified would be the same mistake.
  if (!claims.email || claims.email_verified !== true) {
    throw new OidcError("auto-provisioning requires a verified email address");
  }
  const at = claims.email.lastIndexOf("@");
  const domain = at < 0 ? "" : claims.email.slice(at + 1).toLowerCase();
  if (!domain || !allowedDomains.includes(domain)) {
    throw new OidcError(`domain ${domain || "(none)"} is not permitted to provision an identity`);
  }

  // The principal is the email at creation time. It is a display name from
  // here on: the (issuer, subject) link is what identifies this person on
  // every subsequent login, so a later email change does not orphan them.
  const [created] = await db
    .insert(identities)
    .values({ kind: "human", principal: claims.email })
    .returning({ id: identities.id });
  const identityId = created!.id;
  await db.insert(externalIdentities).values({
    issuer: claims.iss,
    subject: claims.sub,
    identityId,
    email: claims.email,
    lastLoginAt: new Date(),
  });
  return { identityId, principal: claims.email, created: true };
}

// A login token carries an org only when the answer is unambiguous. With no
// memberships there is nothing to carry; with more than one there is no way to
// know which was meant, and picking would be a silent grant. requireOrgAccess
// already fails closed on a null org, so ambiguity resolves to "no org
// access", not to "some org's access".
async function soleOrgFor(db: Db, identityId: string): Promise<string | null> {
  const rows = await db
    .select({ orgId: orgMemberships.orgId })
    .from(orgMemberships)
    .where(eq(orgMemberships.identityId, identityId));
  return rows.length === 1 ? rows[0]!.orgId : null;
}

export function registerOidcRoutes(app: FastifyInstance, db: Db, cfg: OidcConfig): void {
  const provider = new OidcProvider(cfg.discoveryUrl, cfg.issuer);
  const redirectUri = `${cfg.publicUrl.replace(/\/$/, "")}/auth/oidc/callback`;
  const secureCookies = cfg.publicUrl.startsWith("https://");

  app.get("/auth/oidc/start", async (_req, reply) => {
    const flow: FlowState = {
      state: randomBytes(32).toString("base64url"),
      nonce: randomBytes(32).toString("base64url"),
      verifier: randomBytes(32).toString("base64url"),
      expiresAt: Date.now() + FLOW_TTL_MS,
    };

    let discovery;
    try {
      discovery = await provider.getDiscovery();
    } catch (err) {
      reply.code(502).send({ message: `identity provider unreachable: ${(err as Error).message}` });
      return;
    }

    const params = new URLSearchParams({
      client_id: cfg.clientId,
      response_type: "code",
      scope: "openid email profile",
      redirect_uri: redirectUri,
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: pkceChallengeFor(flow.verifier),
      code_challenge_method: "S256",
    });

    setFlowCookie(reply, sealFlow(flow, cfg.cookieKey), secureCookies);
    reply.header("Cache-Control", "no-store");
    reply.redirect(`${discovery.authorization_endpoint}?${params.toString()}`, 302);
  });

  app.get("/auth/oidc/callback", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const query = req.query as Record<string, string | undefined>;

    // The issuer reports user-facing failures (a denied consent screen) here
    // rather than by not arriving. Surfacing it beats a generic 400.
    if (query.error) {
      clearFlowCookie(reply, secureCookies);
      reply.code(400).send({ message: `authorization failed: ${query.error}` });
      return;
    }

    const sealed = readCookie(req.headers.cookie, FLOW_COOKIE);
    const flow = sealed ? openFlow(sealed, cfg.cookieKey) : null;
    if (!flow) {
      reply.code(400).send({ message: "no valid login is in progress; start again" });
      return;
    }
    // Single-use by construction: whatever happens next, this cookie stops
    // being able to complete a flow.
    clearFlowCookie(reply, secureCookies);

    if (typeof query.state !== "string" || !safeEqual(query.state, flow.state)) {
      reply.code(400).send({ message: "state does not match the login in progress" });
      return;
    }
    if (typeof query.code !== "string" || !query.code) {
      reply.code(400).send({ message: "no authorization code" });
      return;
    }

    try {
      const discovery = await provider.getDiscovery();
      const tokenRes = await fetch(discovery.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: query.code,
          redirect_uri: redirectUri,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          code_verifier: flow.verifier,
        }),
      });
      if (!tokenRes.ok) {
        reply.code(502).send({ message: `token exchange failed: ${tokenRes.status}` });
        return;
      }
      const tokens = (await tokenRes.json()) as { id_token?: string };
      if (!tokens.id_token) {
        reply.code(502).send({ message: "token response contained no id_token" });
        return;
      }

      const claims = await provider.verifyIdToken(tokens.id_token, {
        clientId: cfg.clientId,
        nonce: flow.nonce,
      });

      const resolved = await resolveIdentity(db, claims, cfg.allowedDomains);
      const orgId = await soleOrgFor(db, resolved.identityId);
      const expiresAt = new Date(Date.now() + cfg.tokenTtlMinutes * 60_000);

      const token = await db.transaction(async (tx) => {
        const minted = await mintToken(tx, resolved.identityId, [...LOGIN_SCOPES], {
          orgId: orgId ?? undefined,
          expiresAt,
        });
        // The op log records that a credential was created and how it was
        // proved — issuer and subject, never the token and never the ID
        // token. "Who logged in, when, via which provider" becomes a history
        // query for free, which is the whole argument for the operations
        // spine being the audit log.
        await recordOperation(tx, {
          repoId: null,
          orgId,
          actorId: resolved.identityId,
          verb: "auth.login",
          target: resolved.principal,
          after: {
            issuer: claims.iss,
            subject: claims.sub,
            identity_created: resolved.created,
            scopes: [...LOGIN_SCOPES],
            org_id: orgId,
          },
        });
        return minted;
      });

      reply.code(200).send({
        token,
        identity_id: resolved.identityId,
        principal: resolved.principal,
        scopes: [...LOGIN_SCOPES],
        org_id: orgId,
        expires_at: expiresAt.toISOString(),
      });
    } catch (err) {
      if (err instanceof OidcError) {
        // 403, not 401: the caller authenticated to the issuer perfectly well.
        // What failed is our decision about whether that person may have a
        // token here, and saying "unauthorized" would send them to log in
        // again forever.
        req.log.warn({ err: err.message }, "oidc login refused");
        reply.code(403).send({ message: err.message });
        return;
      }
      throw err;
    }
  });
}
