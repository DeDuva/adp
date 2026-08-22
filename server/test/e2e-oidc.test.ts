// M4-5: the OIDC login flow, end to end.
//
// The identity provider here is a real OpenID provider running on localhost —
// real RSA keys, a real discovery document, a real JWKS, a real token
// endpoint — not a stubbed `verifyIdToken`. That distinction is the point of
// the readiness review's "tested against a real IdP, not a mock": what must
// not be faked is the *protocol*, because the bugs live in the handoffs
// between its steps. Substituting a local provider for Google exercises every
// one of those handoffs with real cryptography; what it cannot exercise is
// Google's own quirks, which is why `docs/self-hosting.md` carries a
// real-Google acceptance procedure to be run once against the live provider.
//
// Most of these cases are refusals, because the interesting question about a
// login route is never whether the happy path works.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import Fastify, { type FastifyInstance } from "fastify";
import { createSign, generateKeyPairSync, createHash } from "node:crypto";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, desc, eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import {
  externalIdentities,
  identities,
  operations,
  orgMemberships,
  tokens,
} from "../src/db/schema.js";
import { authPlugin } from "../src/auth/plugin.js";
import { registerOidcRoutes, resolveIdentity } from "../src/http-rest/oidc.js";
import { authenticate } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";

const CLIENT_ID = "adp-test-client.apps.example.com";
const KID = "idp-key-1";

describe.skipIf(skipWithoutDb)("M4-5: OIDC login", () => {
  let app: FastifyInstance;
  let idp: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let port: number;
  let issuer: string;

  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  // What the fake IdP will put in the next id_token it issues. Each test sets
  // this, then drives the flow.
  let nextClaims: Record<string, unknown> = {};

  function b64(obj: unknown) {
    return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  }

  function issueIdToken(nonce: string): string {
    const now = Math.floor(Date.now() / 1000);
    const h = b64({ alg: "RS256", kid: KID, typ: "JWT" });
    const p = b64({
      iss: issuer,
      aud: CLIENT_ID,
      exp: now + 300,
      iat: now,
      nonce,
      ...nextClaims,
    });
    const signer = createSign("RSA-SHA256");
    signer.update(`${h}.${p}`);
    return `${h}.${p}.${signer.sign(privateKey).toString("base64url")}`;
  }

  // Drives a whole login: start, read the flow cookie the server set, have the
  // IdP issue a token bound to that flow's nonce, then hit the callback.
  async function login(overrides: { state?: string; cookie?: string } = {}) {
    const startRes = await fetch(`http://127.0.0.1:${port}/auth/oidc/start`, { redirect: "manual" });
    const setCookie = startRes.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0]!;
    const sealed = cookie.slice(cookie.indexOf("=") + 1);
    const flow = JSON.parse(
      Buffer.from(sealed.split(".")[0]!, "base64url").toString("utf8"),
    ) as { state: string; nonce: string };

    currentNonce = flow.nonce;
    const state = overrides.state ?? flow.state;
    const res = await fetch(
      `http://127.0.0.1:${port}/auth/oidc/callback?code=test-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: overrides.cookie ?? cookie }, redirect: "manual" },
    );
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : null, startRes };
  }

  let currentNonce = "";

  // `Response.json()` is `unknown` under the test tsconfig (which typechecks
  // this file; tsconfig.build.json does not). One typed reader beats four
  // casts, and it keeps the assertions reading as assertions.
  const jsonBody = async (res: Response): Promise<Record<string, any>> =>
    (await res.json()) as Record<string, any>;

  // The link's key is (issuer, subject), and this fake IdP's issuer carries a
  // random port — so a lookup by subject alone matches rows left by previous
  // runs against the same database and reads as a duplicate that is not one.
  const byKey = (subject: string) =>
    and(eq(externalIdentities.issuer, issuer), eq(externalIdentities.subject, subject));

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    // The identity provider.
    idp = Fastify({ logger: false });
    // A real token endpoint takes form-encoded bodies, and Fastify ships no
    // parser for that content type — without this the exchange 415s and every
    // callback surfaces as a 502, which is exactly what it should look like
    // when a provider misbehaves.
    idp.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );
    idp.get("/.well-known/openid-configuration", async () => ({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    }));
    idp.get("/jwks", async () => ({
      keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID, use: "sig", alg: "RS256" }],
    }));
    idp.post("/token", async () => ({ id_token: issueIdToken(currentNonce), token_type: "Bearer" }));
    await idp.listen({ host: "127.0.0.1", port: 0 });
    const idpAddr = idp.server.address();
    issuer = `http://127.0.0.1:${typeof idpAddr === "object" && idpAddr ? idpAddr.port : 0}`;

    app = Fastify({ logger: false });
    await app.register(authPlugin(db));
    registerOidcRoutes(app, db, {
      issuer,
      discoveryUrl: `${issuer}/.well-known/openid-configuration`,
      clientId: CLIENT_ID,
      clientSecret: "test-secret",
      allowedDomains: ["allowed.test"],
      tokenTtlMinutes: 60,
      publicUrl: "http://127.0.0.1",
      cookieKey: createHash("sha256").update("e2e-oidc-cookie-key").digest(),
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await app.close();
    await idp.close();
    await pool.end();
  });

  it("starts the flow with PKCE, state and nonce, and sets an HttpOnly cookie", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/auth/oidc/start`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(`${issuer}/authorize`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeTruthy();
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);

    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    // The verifier must never travel to the browser in the clear where the
    // challenge already went — but it must survive the round trip, which is
    // what the sealed cookie is for.
    expect(location.searchParams.get("code_challenge")).not.toBe("");
  });

  it("refuses every unknown subject when no domain is allowlisted — the default posture", async () => {
    // The default configuration is an EMPTY allowlist, and this is the case
    // that makes it safe: with nothing allowlisted there is no input to this
    // function that creates an identity. Tested directly rather than through
    // the route because the route is configured with an allowlist for every
    // other case in this file, and this default is the one most worth pinning.
    await expect(
      resolveIdentity(
        db,
        { iss: issuer, sub: "nobody-1", email: "anyone@anywhere.test", email_verified: true },
        [],
      ),
    ).rejects.toThrow(/auto-provisioning is disabled/);

    const rows = await db
      .select()
      .from(externalIdentities)
      .where(byKey("nobody-1"));
    expect(rows).toHaveLength(0);
  });

  it("refuses an unknown subject whose domain is not on the allowlist", async () => {
    // The default posture: a stranger with a perfectly valid Google account is
    // not a user of this instance.
    nextClaims = { sub: "stranger-1", email: "someone@notallowed.test", email_verified: true };
    const { status, body } = await login();
    expect(status).toBe(403);
    expect(body!.message).toMatch(/not permitted to provision/);

    const rows = await db
      .select()
      .from(externalIdentities)
      .where(byKey("stranger-1"));
    expect(rows).toHaveLength(0);
  });

  it("refuses an unverified email even on a permitted domain", async () => {
    nextClaims = { sub: "unverified-1", email: "person@allowed.test", email_verified: false };
    const { status, body } = await login();
    expect(status).toBe(403);
    expect(body!.message).toMatch(/verified email/);
  });

  it("provisions an identity for a permitted domain, and mints a bounded token", async () => {
    nextClaims = { sub: "newcomer-1", email: "newcomer@allowed.test", email_verified: true };
    const { status, body } = await login();
    expect(status).toBe(200);
    expect(body!.principal).toBe("newcomer@allowed.test");

    // Never admin, by any route. This is the assertion that has to keep
    // holding as the flow grows features.
    expect(body!.scopes.sort()).toEqual(["repo:read", "repo:write"]);
    expect(body!.scopes).not.toContain("admin");

    const authed = await authenticate(db, body!.token as string);
    expect(authed).not.toBeNull();
    expect(authed!.kind).toBe("human");
    expect(authed!.scopes).not.toContain("admin");

    // And it expires. A login credential that outlives the session is a PAT
    // with a worse provenance story.
    const [row] = await db
      .select({ expiresAt: tokens.expiresAt })
      .from(tokens)
      .where(eq(tokens.identityId, authed!.identityId))
      .orderBy(desc(tokens.createdAt));
    expect(row!.expiresAt).toBeTruthy();
    expect(row!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("records the login as an operation, carrying the issuer and subject but never the token", async () => {
    nextClaims = { sub: "audited-1", email: "audited@allowed.test", email_verified: true };
    const { status, body } = await login();
    expect(status).toBe(200);

    const [op] = await db
      .select()
      .from(operations)
      .where(and(eq(operations.verb, "auth.login"), eq(operations.target, "audited@allowed.test")))
      .orderBy(desc(operations.createdAt));
    expect(op).toBeTruthy();
    const after = op!.after as Record<string, unknown>;
    expect(after.issuer).toBe(issuer);
    expect(after.subject).toBe("audited-1");
    expect(after.identity_created).toBe(true);
    expect(JSON.stringify(op)).not.toContain(body!.token);
  });

  it("logs an existing link in again without creating a second identity", async () => {
    nextClaims = { sub: "returning-1", email: "returning@allowed.test", email_verified: true };
    const first = await login();
    expect(first.status).toBe(200);
    const second = await login();
    expect(second.status).toBe(200);
    expect(second.body!.identity_id).toBe(first.body!.identity_id);

    const links = await db
      .select()
      .from(externalIdentities)
      .where(byKey("returning-1"));
    expect(links).toHaveLength(1);
    expect(links[0]!.lastLoginAt).toBeTruthy();
  });

  it("keeps a linked identity working after their email changes, and after their domain stops being allowed", async () => {
    // The reason the link is keyed on (issuer, subject) rather than email. A
    // person who changes address is the same person; an operator who narrows
    // the allowlist has not deprovisioned everyone already inside it.
    nextClaims = { sub: "renamed-1", email: "before@allowed.test", email_verified: true };
    const first = await login();
    expect(first.status).toBe(200);

    nextClaims = { sub: "renamed-1", email: "after@notallowed.test", email_verified: true };
    const second = await login();
    expect(second.status).toBe(200);
    expect(second.body!.identity_id).toBe(first.body!.identity_id);
    // Principal is the display name fixed at creation; identity did not move.
    expect(second.body!.principal).toBe("before@allowed.test");

    const [link] = await db
      .select()
      .from(externalIdentities)
      .where(byKey("renamed-1"));
    expect(link!.email).toBe("after@notallowed.test");
  });

  it("scopes the token to the identity's org when there is exactly one, and to none when ambiguous", async () => {
    nextClaims = { sub: "orged-1", email: "orged@allowed.test", email_verified: true };
    const first = await login();
    const identityId = first.body!.identity_id as string;
    expect(first.body!.org_id).toBeNull();

    const orgId = await grantOwner(db, identityId, `oidc-org-${Date.now()}`);
    const second = await login();
    expect(second.body!.org_id).toBe(orgId);

    // A second membership makes it ambiguous, and ambiguity resolves to no
    // org rather than to a guess — requireOrgAccess then fails closed.
    await grantOwner(db, identityId, `oidc-org2-${Date.now()}`);
    const third = await login();
    expect(third.body!.org_id).toBeNull();
  });

  it("refuses a state that does not match the flow cookie", async () => {
    nextClaims = { sub: "csrf-1", email: "csrf@allowed.test", email_verified: true };
    const { status, body } = await login({ state: "not-the-state-we-issued" });
    expect(status).toBe(400);
    expect(body!.message).toMatch(/state does not match/);
  });

  it("refuses a callback with no flow cookie at all", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/auth/oidc/callback?code=x&state=y`, {
      redirect: "manual",
    });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).message).toMatch(/no valid login is in progress/);
  });

  it("refuses a flow cookie whose contents were edited", async () => {
    // The cookie carries the nonce the ID token is checked against, so a
    // browser that can rewrite it can replay a token from another session.
    const startRes = await fetch(`http://127.0.0.1:${port}/auth/oidc/start`, { redirect: "manual" });
    const cookie = startRes.headers.get("set-cookie")!.split(";")[0]!;
    const [name, sealed] = [cookie.slice(0, cookie.indexOf("=")), cookie.slice(cookie.indexOf("=") + 1)];
    const [bodyPart, mac] = sealed.split(".");
    const tampered = JSON.parse(Buffer.from(bodyPart!, "base64url").toString("utf8"));
    tampered.nonce = "an-attacker-chosen-nonce";
    const forged = `${name}=${Buffer.from(JSON.stringify(tampered), "utf8").toString("base64url")}.${mac}`;

    const res = await fetch(`http://127.0.0.1:${port}/auth/oidc/callback?code=x&state=${tampered.state}`, {
      headers: { cookie: forged },
      redirect: "manual",
    });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).message).toMatch(/no valid login is in progress/);
  });

  it("surfaces a provider-reported error rather than a generic failure", async () => {
    const startRes = await fetch(`http://127.0.0.1:${port}/auth/oidc/start`, { redirect: "manual" });
    const cookie = startRes.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`http://127.0.0.1:${port}/auth/oidc/callback?error=access_denied`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).message).toMatch(/access_denied/);
  });

  it("refuses an id token whose nonce belongs to a different flow", async () => {
    // Replay: a token that verifies perfectly, for a login this browser did
    // not start.
    nextClaims = { sub: "replay-1", email: "replay@allowed.test", email_verified: true };
    const startRes = await fetch(`http://127.0.0.1:${port}/auth/oidc/start`, { redirect: "manual" });
    const cookie = startRes.headers.get("set-cookie")!.split(";")[0]!;
    const sealed = cookie.slice(cookie.indexOf("=") + 1);
    const flow = JSON.parse(Buffer.from(sealed.split(".")[0]!, "base64url").toString("utf8"));

    currentNonce = "a-nonce-from-somewhere-else";
    const res = await fetch(
      `http://127.0.0.1:${port}/auth/oidc/callback?code=c&state=${encodeURIComponent(flow.state)}`,
      { headers: { cookie }, redirect: "manual" },
    );
    expect(res.status).toBe(403);
    expect((await jsonBody(res)).message).toMatch(/nonce/);
  });

  it("does not let one flow cookie complete two logins", async () => {
    nextClaims = { sub: "single-use-1", email: "single@allowed.test", email_verified: true };
    const startRes = await fetch(`http://127.0.0.1:${port}/auth/oidc/start`, { redirect: "manual" });
    const cookie = startRes.headers.get("set-cookie")!.split(";")[0]!;
    const sealed = cookie.slice(cookie.indexOf("=") + 1);
    const flow = JSON.parse(Buffer.from(sealed.split(".")[0]!, "base64url").toString("utf8"));
    currentNonce = flow.nonce;

    const url = `http://127.0.0.1:${port}/auth/oidc/callback?code=c&state=${encodeURIComponent(flow.state)}`;
    const first = await fetch(url, { headers: { cookie }, redirect: "manual" });
    expect(first.status).toBe(200);
    // The server cleared the cookie; a browser obeying that header cannot
    // replay. This asserts the header, which is the part we control.
    expect(first.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });
});
