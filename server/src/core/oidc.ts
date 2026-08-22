// M4-5: OpenID Connect ID-token verification, and the discovery/JWKS fetching
// it needs.
//
// Written against Node's own crypto rather than a JWT library, for the reason
// this project argues in the brief's §f: a dependency on the path that decides
// who gets to log in is a supply-chain surface, and the verification an ID
// token needs is narrow enough to state completely. That trade is only sound
// if the negative cases are tested as hard as the positive one, so oidc.test.ts
// carries a case per rejection below — algorithm confusion, `alg: none`, an
// unknown `kid`, a tampered payload, a wrong issuer, a wrong audience, an
// expired token, a replayed nonce.
//
// What is deliberately NOT here: anything that decides whether a verified
// person may log in. This module answers "is this ID token authentic and
// intact?" and nothing else. Admission is http-rest/oidc.ts's job, and it
// fails closed.

import {
  createPublicKey,
  createHash,
  timingSafeEqual,
  verify as cryptoVerify,
  type JsonWebKey,
} from "node:crypto";

// Only RS256. Google signs with it, and an allowlist of exactly one is what
// makes algorithm confusion impossible rather than merely unlikely: there is
// no branch here that can be steered into HMAC-verifying against a public key,
// and no `alg: none` path to fall through to.
const ALLOWED_ALG = "RS256";

// Tolerance for clock skew between us and the issuer, applied to exp/iat/nbf.
// Small on purpose: this is a clock-drift allowance, not a grace period.
const CLOCK_SKEW_SECONDS = 60;

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nbf?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  hd?: string;
  azp?: string;
}

export class OidcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcError";
  }
}

function base64UrlDecode(segment: string): Buffer {
  // Reject anything that is not base64url before decoding: Buffer.from is
  // lenient and will happily skip characters it does not recognise, which
  // would let a mutated segment decode to the same bytes as the original.
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) {
    throw new OidcError("token segment is not valid base64url");
  }
  return Buffer.from(segment, "base64url");
}

function decodeJson(segment: string): unknown {
  const text = base64UrlDecode(segment).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new OidcError("token segment is not valid JSON");
  }
}

// Constant-time string comparison for the values an attacker can vary and
// guess at — the nonce and the state. Length is allowed to leak; the contents
// are not.
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Structurally a JsonWebKey, plus the metadata the selection above reads.
// Typed as JsonWebKey rather than a hand-rolled shape so createPublicKey
// accepts it without a cast — a cast here would be casting away exactly the
// check that says these bytes are a key.
type Jwk = JsonWebKey & { kid?: string; use?: string; alg?: string };

type Fetcher = typeof fetch;

// Discovery and JWKS both cache, because both are fetched on a request path a
// user is waiting on. The JWKS cache additionally refetches once on an unknown
// `kid`, which is what makes an issuer's key rotation invisible here instead
// of an outage — the same problem #102's key registry solved for our own
// signing keys, one issuer over.
export class OidcProvider {
  private discovery: OidcDiscovery | null = null;
  private discoveryFetchedAt = 0;
  private jwks: Map<string, Jwk> = new Map();
  private jwksFetchedAt = 0;

  constructor(
    private readonly discoveryUrl: string,
    private readonly expectedIssuer: string,
    private readonly fetchImpl: Fetcher = fetch,
    private readonly cacheTtlMs = 3_600_000,
  ) {}

  async getDiscovery(): Promise<OidcDiscovery> {
    if (this.discovery && Date.now() - this.discoveryFetchedAt < this.cacheTtlMs) {
      return this.discovery;
    }
    const res = await this.fetchImpl(this.discoveryUrl);
    if (!res.ok) throw new OidcError(`discovery fetch failed: ${res.status}`);
    const doc = (await res.json()) as OidcDiscovery;

    // The discovery document names its own issuer, and that name is what every
    // subsequent `iss` check compares against. If a hijacked or misconfigured
    // discovery URL could set it, verification would be checking a token
    // against the attacker's own claim about who signed it.
    if (doc.issuer !== this.expectedIssuer) {
      throw new OidcError(
        `discovery issuer ${doc.issuer} does not match configured issuer ${this.expectedIssuer}`,
      );
    }
    for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
      if (typeof doc[field] !== "string" || !doc[field]) {
        throw new OidcError(`discovery document is missing ${field}`);
      }
    }
    this.discovery = doc;
    this.discoveryFetchedAt = Date.now();
    return doc;
  }

  private async loadJwks(force: boolean): Promise<void> {
    if (!force && this.jwks.size > 0 && Date.now() - this.jwksFetchedAt < this.cacheTtlMs) return;
    const { jwks_uri } = await this.getDiscovery();
    const res = await this.fetchImpl(jwks_uri);
    if (!res.ok) throw new OidcError(`jwks fetch failed: ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    const next = new Map<string, Jwk>();
    for (const key of body.keys ?? []) {
      // Only RSA signing keys are usable here, and only ones that name a kid.
      // A key with no kid cannot be selected unambiguously, and guessing is
      // how you end up verifying against whichever key happens to be first.
      if (key.kty !== "RSA" || !key.kid) continue;
      if (key.use && key.use !== "sig") continue;
      if (key.alg && key.alg !== ALLOWED_ALG) continue;
      next.set(key.kid, key);
    }
    if (next.size === 0) throw new OidcError("jwks contained no usable RSA signing keys");
    this.jwks = next;
    this.jwksFetchedAt = Date.now();
  }

  private async keyFor(kid: string): Promise<Jwk> {
    await this.loadJwks(false);
    const hit = this.jwks.get(kid);
    if (hit) return hit;
    // Unknown kid: the issuer may have rotated since the last fetch. Refetch
    // exactly once, then give up — an unbounded refetch on unknown kid is a
    // denial-of-service amplifier pointed at the issuer.
    await this.loadJwks(true);
    const retry = this.jwks.get(kid);
    if (!retry) throw new OidcError(`no signing key for kid ${kid}`);
    return retry;
  }

  // Verifies signature and claims, and returns the claims only if every check
  // passed. There is no partial success and no "verified except" result: the
  // caller cannot accidentally use an unverified claim because it never
  // receives one.
  async verifyIdToken(
    idToken: string,
    opts: { clientId: string; nonce: string; now?: Date },
  ): Promise<IdTokenClaims> {
    const parts = idToken.split(".");
    if (parts.length !== 3) throw new OidcError("id token is not a three-part JWS");
    const [headerSeg, payloadSeg, signatureSeg] = parts as [string, string, string];

    const header = decodeJson(headerSeg) as { alg?: string; kid?: string; typ?: string };
    if (header.alg !== ALLOWED_ALG) {
      throw new OidcError(`unsupported id token algorithm: ${String(header.alg)}`);
    }
    if (!header.kid) throw new OidcError("id token header has no kid");

    const jwk = await this.keyFor(header.kid);
    const key = createPublicKey({ key: jwk, format: "jwk" });

    // Signature first. Nothing in the payload is trusted, or even inspected
    // for meaning, until the bytes it sits in are known to be the issuer's.
    const signed = Buffer.from(`${headerSeg}.${payloadSeg}`, "ascii");
    const signature = base64UrlDecode(signatureSeg);
    if (!cryptoVerify("RSA-SHA256", signed, key, signature)) {
      throw new OidcError("id token signature is invalid");
    }

    const claims = decodeJson(payloadSeg) as IdTokenClaims;
    const nowSec = Math.floor((opts.now?.getTime() ?? Date.now()) / 1000);

    if (claims.iss !== this.expectedIssuer) {
      throw new OidcError(`id token issuer ${String(claims.iss)} is not ${this.expectedIssuer}`);
    }
    if (typeof claims.sub !== "string" || claims.sub.length === 0) {
      throw new OidcError("id token has no subject");
    }

    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(opts.clientId)) {
      throw new OidcError("id token audience does not include this client");
    }
    // With multiple audiences the spec requires azp, and requires it to be us.
    // Without this a token minted for a different client that happens to list
    // us as a secondary audience would authenticate here.
    if (audiences.length > 1 && claims.azp !== opts.clientId) {
      throw new OidcError("id token has multiple audiences and azp is not this client");
    }

    if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < nowSec) {
      throw new OidcError("id token is expired");
    }
    if (typeof claims.iat !== "number" || claims.iat - CLOCK_SKEW_SECONDS > nowSec) {
      throw new OidcError("id token was issued in the future");
    }
    if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > nowSec) {
      throw new OidcError("id token is not yet valid");
    }

    // The nonce binds this token to the authorization request this browser
    // started. Without it a token obtained elsewhere — from another session,
    // or replayed — verifies perfectly well and logs someone else in.
    if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, opts.nonce)) {
      throw new OidcError("id token nonce does not match the authorization request");
    }

    return claims;
  }
}

// PKCE. The verifier is the secret; the challenge is what travels in the
// authorization request. Google does not require PKCE for a confidential
// client, and it is here anyway: it costs one hash and it removes the entire
// class of attack where a leaked authorization code is redeemed by someone
// who did not start the flow.
export function pkceChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
