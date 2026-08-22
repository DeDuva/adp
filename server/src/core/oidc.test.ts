// The case for verifying ID tokens with Node's crypto instead of a JWT
// library rests entirely on this file. Every rejection core/oidc.ts can make
// has a test here, because an unverified verifier is worse than a dependency:
// it fails open, quietly, on exactly the path that decides who is allowed in.

import { describe, expect, it } from "vitest";
import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { OidcError, OidcProvider, pkceChallengeFor, safeEqual } from "./oidc.js";

const ISSUER = "https://issuer.test";
const CLIENT_ID = "client-abc.apps.example.com";
const NONCE = "nonce-value-0123456789";
const KID = "test-key-1";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
// A second key the provider never publishes — the "signed by someone else"
// case, which is the one an attacker actually has.
const foreign = generateKeyPairSync("rsa", { modulusLength: 2048 });

function jwkFor(key: KeyObject, kid: string) {
  return { ...key.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };
}

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function sign(headerSeg: string, payloadSeg: string, key: KeyObject): string {
  const signer = createSign("RSA-SHA256");
  signer.update(`${headerSeg}.${payloadSeg}`);
  return signer.sign(key).toString("base64url");
}

function makeToken(
  overrides: {
    header?: Record<string, unknown>;
    claims?: Record<string, unknown>;
    key?: KeyObject;
    signature?: string;
  } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: KID, typ: "JWT", ...overrides.header };
  const claims = {
    iss: ISSUER,
    sub: "subject-123",
    aud: CLIENT_ID,
    exp: now + 300,
    iat: now,
    nonce: NONCE,
    email: "person@example.com",
    email_verified: true,
    ...overrides.claims,
  };
  const h = b64(header);
  const p = b64(claims);
  const s = overrides.signature ?? sign(h, p, overrides.key ?? privateKey);
  return `${h}.${p}.${s}`;
}

function providerWith(keys: unknown[] = [jwkFor(publicKey, KID)], issuer = ISSUER) {
  const fetchImpl = (async (url: string | URL) => {
    const href = typeof url === "string" ? url : url.href;
    if (href.endsWith("/.well-known/openid-configuration")) {
      return new Response(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return new OidcProvider(`${ISSUER}/.well-known/openid-configuration`, ISSUER, fetchImpl);
}

const verifyOpts = { clientId: CLIENT_ID, nonce: NONCE };

describe("verifyIdToken — the token that should pass", () => {
  it("accepts a correctly signed token and returns its claims", async () => {
    const claims = await providerWith().verifyIdToken(makeToken(), verifyOpts);
    expect(claims.sub).toBe("subject-123");
    expect(claims.email).toBe("person@example.com");
  });

  it("accepts a token whose kid appeared only after a key rotation", async () => {
    // First call caches a JWKS without this kid; the provider must refetch
    // rather than reject, or every issuer rotation is an outage.
    let served = [jwkFor(foreign.publicKey, "old-key")];
    const fetchImpl = (async (url: string | URL) => {
      const href = typeof url === "string" ? url : url.href;
      if (href.endsWith("openid-configuration")) {
        return new Response(
          JSON.stringify({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            jwks_uri: `${ISSUER}/jwks`,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ keys: served }), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new OidcProvider(`${ISSUER}/.well-known/openid-configuration`, ISSUER, fetchImpl);
    await expect(provider.verifyIdToken(makeToken(), verifyOpts)).rejects.toThrow(/no signing key/);

    served = [jwkFor(publicKey, KID)];
    const claims = await provider.verifyIdToken(makeToken(), verifyOpts);
    expect(claims.sub).toBe("subject-123");
  });
});

describe("verifyIdToken — signature and algorithm", () => {
  it("rejects alg: none", async () => {
    const token = makeToken({ header: { alg: "none" }, signature: "" });
    await expect(providerWith().verifyIdToken(token, verifyOpts)).rejects.toThrow(
      /unsupported id token algorithm/,
    );
  });

  it("rejects HS256 signed with the RSA public key as the HMAC secret", async () => {
    // The textbook algorithm-confusion attack. The public key is public, so if
    // the verifier can be steered into HMAC mode, anyone can mint tokens.
    const now = Math.floor(Date.now() / 1000);
    const h = b64({ alg: "HS256", kid: KID, typ: "JWT" });
    const p = b64({ iss: ISSUER, sub: "attacker", aud: CLIENT_ID, exp: now + 300, iat: now, nonce: NONCE });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const mac = createHash("sha256").update(`${h}.${p}${pem}`).digest("base64url");
    await expect(providerWith().verifyIdToken(`${h}.${p}.${mac}`, verifyOpts)).rejects.toThrow(
      /unsupported id token algorithm/,
    );
  });

  it("rejects a token signed by a key the issuer does not publish", async () => {
    const token = makeToken({ key: foreign.privateKey });
    await expect(providerWith().verifyIdToken(token, verifyOpts)).rejects.toThrow(
      /signature is invalid/,
    );
  });

  it("rejects a tampered payload that keeps the original signature", async () => {
    const original = makeToken();
    const [h, , s] = original.split(".");
    const forged = b64({
      iss: ISSUER,
      sub: "somebody-else",
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
      nonce: NONCE,
    });
    await expect(providerWith().verifyIdToken(`${h}.${forged}.${s}`, verifyOpts)).rejects.toThrow(
      /signature is invalid/,
    );
  });

  it("rejects a header with no kid", async () => {
    const token = makeToken({ header: { kid: undefined } });
    await expect(providerWith().verifyIdToken(token, verifyOpts)).rejects.toThrow(/no kid/);
  });

  it("rejects a token that is not three segments", async () => {
    await expect(providerWith().verifyIdToken("a.b", verifyOpts)).rejects.toThrow(/three-part/);
  });

  it("rejects a segment containing non-base64url characters", async () => {
    const [h, p] = makeToken().split(".");
    await expect(providerWith().verifyIdToken(`${h}.${p}.****`, verifyOpts)).rejects.toThrow(
      OidcError,
    );
  });
});

describe("verifyIdToken — claims", () => {
  it("rejects a wrong issuer", async () => {
    const token = makeToken({ claims: { iss: "https://evil.test" } });
    await expect(providerWith().verifyIdToken(token, verifyOpts)).rejects.toThrow(/issuer/);
  });

  it("rejects a token minted for a different client", async () => {
    const token = makeToken({ claims: { aud: "someone-else.apps.example.com" } });
    await expect(providerWith().verifyIdToken(token, verifyOpts)).rejects.toThrow(/audience/);
  });

  it("rejects multiple audiences when azp is not this client", async () => {
    const token = makeToken({ claims: { aud: [CLIENT_ID, "other"], azp: "other" } });
    await expect(providerWith().verifyIdToken(token, verifyOpts)).rejects.toThrow(/azp/);
  });

  it("accepts multiple audiences when azp is this client", async () => {
    const token = makeToken({ claims: { aud: [CLIENT_ID, "other"], azp: CLIENT_ID } });
    await expect(providerWith().verifyIdToken(token, verifyOpts)).resolves.toBeTruthy();
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = makeToken({ claims: { exp: now - 3600, iat: now - 7200 } });
    await expect(providerWith().verifyIdToken(token, verifyOpts)).rejects.toThrow(/expired/);
  });

  it("rejects a token issued in the future", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = makeToken({ claims: { iat: now + 3600, exp: now + 7200 } });
    await expect(providerWith().verifyIdToken(token, verifyOpts)).rejects.toThrow(/future/);
  });

  it("rejects a mismatched nonce — the replay case", async () => {
    const token = makeToken({ claims: { nonce: "a-different-flows-nonce" } });
    await expect(providerWith().verifyIdToken(token, verifyOpts)).rejects.toThrow(/nonce/);
  });

  it("rejects a token with no nonce at all", async () => {
    const token = makeToken({ claims: { nonce: undefined } });
    await expect(providerWith().verifyIdToken(token, verifyOpts)).rejects.toThrow(/nonce/);
  });

  it("rejects an empty subject", async () => {
    const token = makeToken({ claims: { sub: "" } });
    await expect(providerWith().verifyIdToken(token, verifyOpts)).rejects.toThrow(/subject/);
  });
});

describe("discovery", () => {
  it("refuses a discovery document naming an issuer other than the configured one", async () => {
    // Otherwise the document being fetched gets to declare who signs tokens,
    // and every `iss` check below it is checking a value the attacker chose.
    const provider = providerWith([jwkFor(publicKey, KID)], "https://not-the-issuer.test");
    await expect(provider.getDiscovery()).rejects.toThrow(/does not match configured issuer/);
  });

  it("refuses a JWKS with no usable RSA signing keys", async () => {
    const provider = providerWith([{ kty: "oct", kid: "symmetric" }]);
    await expect(provider.verifyIdToken(makeToken(), verifyOpts)).rejects.toThrow(/no usable/);
  });
});

describe("helpers", () => {
  it("computes the S256 PKCE challenge", async () => {
    // The RFC 7636 appendix-B vector.
    expect(pkceChallengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("compares equal-length strings without leaking on content", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
