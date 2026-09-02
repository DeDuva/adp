import { createSign, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { githubAppInstallations, githubApps } from "../db/schema.js";
import { decryptCredential, encryptCredential } from "./mirror-crypto.js";

// The GitHub App this instance creates for itself, and the token it mints from
// it.
//
// Two things a personal access token cannot do, and the second is why 5c needs
// this before it can publish anything:
//
//   - It carries the developer's whole account scope, expires on their schedule
//     rather than the installation's, and revoking it breaks unrelated things.
//   - **GitHub's Checks API refuses it.** Only a GitHub App can create a check
//     run, so `ADP / change record` and `ADP / policy` are unreachable from a
//     PAT no matter how it is scoped.
//
// The manifest flow is what makes this available to a self-hosted deployment.
// GitHub creates the App in the user's own organisation from a manifest *this
// instance serves*, then hands the credentials back to it — so there is no
// hosted control plane in the middle, and this item is not blocked by the
// budget decision that defers hosted preview.

/** How long an App JWT is valid. GitHub rejects anything over ten minutes. */
const APP_JWT_TTL_S = 540;
/**
 * How long before an installation token's stated expiry we stop reusing it.
 *
 * GitHub issues them for an hour. The margin is not about clock skew so much as
 * about the request that is already in flight when the token turns: a token
 * accepted at send time and expired at receipt is a 401 on a check-run write
 * that nothing retries.
 */
const TOKEN_REFRESH_MARGIN_MS = 120_000;

export interface GitHubAppRecord {
  id: string;
  appId: string;
  slug: string;
  name: string;
  htmlUrl: string;
  clientId: string;
}

/**
 * The manifest GitHub is asked to create an App from.
 *
 * Every permission here is one an item in this phase actually uses, and the
 * list is deliberately not "what an App might want": an installation prompt is
 * read by the person deciding whether to trust this, and a permission with no
 * caller is a request that cannot be justified when they ask.
 */
export function appManifest(publicUrl: string, name: string): Record<string, unknown> {
  return {
    name,
    url: publicUrl,
    hook_attributes: {
      // The App delivers to one endpoint for every installation, unlike the
      // per-repository webhook a PAT setup makes by hand. 5-5's poller still
      // matters regardless: an App still delivers to a reachable URL, and a
      // laptop has none.
      url: `${publicUrl}/webhooks/github/app`,
      active: true,
    },
    redirect_url: `${publicUrl}/api/adp/github-app/callback`,
    public: false,
    default_permissions: {
      // Read the code and the commits: mirror inbound.
      contents: "read",
      // Read pull requests and write nothing to them: #224, #225, #227 ingest,
      // and ADP never merges on GitHub's behalf — 5a settled that GitHub stays
      // the merge authority.
      pull_requests: "read",
      // #226.
      issues: "read",
      // #233 and #234. This is the permission a personal access token cannot
      // carry at all.
      checks: "write",
      // The upstream CI results that become gate evidence (M2 ingest).
      actions: "read",
      metadata: "read",
    },
    default_events: [
      "push",
      "pull_request",
      "pull_request_review",
      "issues",
      "workflow_run",
      "installation",
      "installation_repositories",
    ],
  };
}

/**
 * Exchange a manifest conversion code for the App's credentials, and store them.
 *
 * The code is single-use and short-lived, and everything it returns is a
 * long-lived secret — so this is the one moment where the whole App exists in
 * memory, and it writes encrypted with the same key and mechanism as mirror
 * credentials rather than inventing a second protection story.
 */
export async function convertAppManifest(
  db: Db,
  credentialKey: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubAppRecord> {
  const res = await fetchImpl(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "adp-github-app",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub refused the manifest conversion (${res.status})`);
  }
  const app = (await res.json()) as {
    id: number;
    slug: string;
    name: string;
    html_url: string;
    client_id: string;
    client_secret: string;
    pem: string;
    webhook_secret: string;
  };

  const [row] = await db
    .insert(githubApps)
    .values({
      appId: String(app.id),
      slug: app.slug,
      name: app.name,
      htmlUrl: app.html_url,
      clientId: app.client_id,
      clientSecretCiphertext: encryptCredential(app.client_secret, credentialKey),
      privateKeyCiphertext: encryptCredential(app.pem, credentialKey),
      webhookSecretCiphertext: encryptCredential(app.webhook_secret, credentialKey),
    })
    .returning();

  return {
    id: row!.id,
    appId: row!.appId,
    slug: row!.slug,
    name: row!.name,
    htmlUrl: row!.htmlUrl,
    clientId: row!.clientId,
  };
}

/** The instance's App, if it has created one. */
export async function findGitHubApp(db: Db) {
  const [row] = await db.select().from(githubApps);
  return row ?? null;
}

/**
 * An App-level JWT, signed with the App's own private key.
 *
 * RS256 by hand rather than through a JWT library: it is three base64url
 * segments and one `crypto.createSign` call, and the alternative is a
 * dependency on the security-critical path of every check-run write. `iat` is
 * backdated by a minute because GitHub rejects a token issued in its future,
 * and a server whose clock is a few seconds fast is the ordinary case.
 */
export function appJwt(privateKeyPem: string, appId: string, now: number = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat, exp: iat + APP_JWT_TTL_S, iss: appId };
  const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(privateKeyPem).toString("base64url");
  return `${signingInput}.${signature}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

// Installation tokens last an hour and cost a round trip to mint. The cache is
// per process and deliberately not in the database: it is a credential with a
// short life, and writing it down converts a thing that expires into a thing
// that has to be cleaned up.
const tokenCache = new Map<string, CachedToken>();

/** Clears the process-local token cache. Exists for tests. */
export function resetInstallationTokenCache(): void {
  tokenCache.clear();
}

/**
 * An installation access token for one installation, minted on demand.
 *
 * This is the credential every App-authenticated call uses: it is scoped to the
 * repositories the installer selected through GitHub's own picker, which is
 * what "installation should leave nothing for a human to paste" actually means.
 */
export async function installationToken(
  db: Db,
  credentialKey: string,
  installationId: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now()) return cached.token;

  const app = await findGitHubApp(db);
  if (!app) throw new Error("no GitHub App has been created for this instance");

  const jwt = appJwt(decryptCredential(app.privateKeyCiphertext, credentialKey), app.appId, now());
  const res = await fetchImpl(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${jwt}`,
        "User-Agent": "adp-github-app",
      },
    },
  );
  if (!res.ok) throw new Error(`could not mint an installation token (${res.status})`);
  const body = (await res.json()) as { token: string; expires_at: string };
  tokenCache.set(installationId, { token: body.token, expiresAt: new Date(body.expires_at).getTime() });
  return body.token;
}

/**
 * The installation covering a GitHub account, if the App is installed there and
 * has not been uninstalled.
 */
export async function findInstallation(db: Db, appRowId: string, account: string) {
  const [row] = await db
    .select()
    .from(githubAppInstallations)
    .where(
      and(
        eq(githubAppInstallations.appId, appRowId),
        eq(githubAppInstallations.account, account),
        isNull(githubAppInstallations.suspendedAt),
      ),
    );
  return row ?? null;
}

/** Records an installation, or revives one that was uninstalled and added back. */
export async function recordInstallation(
  db: Db,
  appRowId: string,
  installationId: string,
  account: string,
): Promise<void> {
  await db
    .insert(githubAppInstallations)
    .values({ appId: appRowId, installationId, account })
    .onConflictDoUpdate({
      target: [githubAppInstallations.appId, githubAppInstallations.installationId],
      set: { account, suspendedAt: null },
    });
}

/**
 * Marks an installation gone.
 *
 * The row survives, because "uninstalling is clean" means ADP stops receiving
 * events — not that the record of what it ingested while installed disappears.
 * Every change, proposal and gate result produced under this installation still
 * points at it.
 */
export async function suspendInstallation(db: Db, appRowId: string, installationId: string): Promise<void> {
  await db
    .update(githubAppInstallations)
    .set({ suspendedAt: new Date() })
    .where(
      and(
        eq(githubAppInstallations.appId, appRowId),
        eq(githubAppInstallations.installationId, installationId),
      ),
    );
  tokenCache.delete(installationId);
}

/** A single-use, unguessable value tying a manifest POST to its callback. */
export function newManifestState(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Verifies GitHub's `X-Hub-Signature-256` over a raw body.
 *
 * The same construction the per-repository webhook uses, exported here so the
 * App's single endpoint does not grow a second implementation of it — one of
 * which would eventually be the one with the timing leak.
 */
export function verifyAppSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"), "hex");
  const actual = Buffer.from(header.slice("sha256=".length), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
