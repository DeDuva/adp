import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { generateKeyPairSync, createVerify, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { skipWithoutDb } from "./require-db.js";
import { githubAppInstallations, githubApps, identities, proposals } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerMirrorRoutes } from "../src/http-rest/mirrors.js";
import { registerMirrorWebhookRawBodyParser } from "../src/http-rest/mirror-webhook.js";
import { registerGitHubAppRoutes } from "../src/http-rest/github-app.js";
import { appJwt, installationToken, resetInstallationTokenCache } from "../src/core/github-app.js";
import { decryptCredential } from "../src/core/mirror-crypto.js";
import { findRepo } from "../src/core/repos-lookup.js";

const CREDENTIAL_KEY = "e2e-github-app-credential-key";
const PUBLIC_URL = "https://adp.example.com";

// #232 — the App this instance creates for itself.
//
// Setting up companion mode cost a personal access token and a webhook made by
// hand in GitHub's settings, using a URL `adp init` prints as
// `<your ADP public URL>/…` because it does not know it. Three manual steps and
// one secret before anything works — and a PAT is the wrong credential shape
// regardless: it carries the developer's whole account scope, it expires on
// their schedule rather than the installation's, and revoking it breaks
// unrelated things. It also cannot do what 5c needs next, because GitHub's
// Checks API refuses personal access tokens outright.
//
// The manifest flow is what makes this available to a self-hosted deployment
// rather than only to a hosted one: GitHub creates the App in the user's own
// organisation from a manifest *this instance serves*, and hands the
// credentials back to it. No control plane in the middle holding everyone's
// keys.
describe.skipIf(skipWithoutDb)("#232: the GitHub App manifest flow", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  const owner = `gh-app-owner-${Date.now()}`;
  // The upstream repository name is unique per run for the reason the owner is,
  // and one step further: this case finds an ADP repository *by* its upstream
  // URL, so a mirror row left by a previous run against the same URL is one
  // this lookup legitimately matches.
  const upstreamRepo = `app-routed-${Date.now()}`;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  let upstreamCalls: { url: string; auth: string | null }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    upstreamCalls.push({
      url,
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null,
    });
    if (url.includes("/app-manifests/")) {
      return new Response(
        JSON.stringify({
          id: 9090,
          slug: "adp-example",
          name: "ADP (adp.example.com)",
          html_url: "https://github.com/apps/adp-example",
          client_id: "Iv1.abc",
          client_secret: "client-secret-value",
          pem,
          webhook_secret: "app-webhook-secret",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/access_tokens")) {
      return new Response(
        JSON.stringify({ token: "ghs_installation_token", expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-gh-app-"));
    const gitBackend = new GitBackend(gitRoot);

    app = Fastify({ logger: false });
    registerMirrorWebhookRawBodyParser(app);
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, PUBLIC_URL);
    registerMirrorRoutes(app, db, CREDENTIAL_KEY);
    registerGitHubAppRoutes(app, db, gitBackend, new Signer("k"), CREDENTIAL_KEY, PUBLIC_URL, fetchImpl);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `gh-app-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // One App per instance is enforced, so each case starts from none.
    await db.delete(githubAppInstallations);
    await db.delete(githubApps);
    resetInstallationTokenCache();
    upstreamCalls = [];
  });

  function get(p: string, auth = true) {
    return fetch(`http://127.0.0.1:${port}${p}`, {
      headers: auth ? { Authorization: `Bearer ${token}` } : {},
    });
  }

  async function stateFromForm(): Promise<string> {
    const res = await get("/github-app/new", false);
    const html = await res.text();
    return decodeURIComponent(/state=([^"]+)"/.exec(html)![1]!);
  }

  it("serves a manifest naming only permissions this phase actually uses", async () => {
    const res = await get("/github-app/new", false);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();

    // A browser form POST is the only way GitHub accepts a manifest — there is
    // no API for it, which is exactly what lets a self-hosted instance create
    // its own App.
    expect(html).toContain('action="https://github.com/settings/apps/new');
    const manifest = JSON.parse(
      /name="manifest" value="([^"]*)"/
        .exec(html)![1]!
        .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c))),
    ) as { default_permissions: Record<string, string>; hook_attributes: { url: string } };

    // `checks: write` is the permission a personal access token cannot carry
    // at all, and the reason this item blocks the two after it.
    expect(manifest.default_permissions.checks).toBe("write");
    // Read-only on pull requests: 5a settled that GitHub stays the merge
    // authority, so ADP has no business writing to them.
    expect(manifest.default_permissions.pull_requests).toBe("read");
    expect(manifest.default_permissions).not.toHaveProperty("administration");
    expect(manifest.hook_attributes.url).toBe(`${PUBLIC_URL}/webhooks/github/app`);
  });

  it("converts the manifest, stores every secret encrypted, and never serves one back", async () => {
    const state = await stateFromForm();
    const res = await get(`/api/adp/github-app/callback?code=abc123&state=${encodeURIComponent(state)}`, false);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      app_id: "9090",
      slug: "adp-example",
      install_url: "https://github.com/apps/adp-example/installations/new",
    });

    const [row] = await db.select().from(githubApps);
    // Encrypted at rest with the same key and mechanism as mirror credentials,
    // which is the protection this was asked to match.
    expect(row!.privateKeyCiphertext).not.toContain("PRIVATE KEY");
    expect(decryptCredential(row!.privateKeyCiphertext, CREDENTIAL_KEY)).toBe(pem);
    expect(decryptCredential(row!.webhookSecretCiphertext, CREDENTIAL_KEY)).toBe("app-webhook-secret");

    // The read route serves no secret, not even truncated: the private key can
    // mint an installation token for every repository the App is installed on.
    const read = await get("/api/adp/github-app");
    const body = (await read.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ app_id: "9090", client_id: "Iv1.abc" });
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(body)).not.toContain("client-secret-value");
    expect(JSON.stringify(body)).not.toContain("app-webhook-secret");
  });

  it("refuses a callback whose state it did not sign", async () => {
    const res = await get("/api/adp/github-app/callback?code=abc123&state=not-a-real-state", false);
    expect(res.status).toBe(400);
    expect(await db.select().from(githubApps)).toHaveLength(0);
  });

  it("refuses a second App, because the App is the instance's identity to GitHub", async () => {
    const state = await stateFromForm();
    await get(`/api/adp/github-app/callback?code=abc123&state=${encodeURIComponent(state)}`, false);

    // The form stops offering to create one, and says where the existing App
    // is instead — the installer's actual next step is to add repositories to
    // it, not to make another.
    const form = await get("/github-app/new", false);
    expect(form.status).toBe(409);
    expect(await form.text()).toContain("https://github.com/apps/adp-example");

    // And the callback refuses even when the state is one this instance really
    // did sign, because the guard is "an App exists" rather than "the form
    // declined to hand out a state".
    const res = await get(`/api/adp/github-app/callback?code=def456&state=${encodeURIComponent(state)}`, false);
    expect(res.status).toBe(409);
    expect(await db.select().from(githubApps)).toHaveLength(1);
  });

  // The JWT is what authenticates the App to GitHub before any installation
  // exists. Verified against the real public key rather than by shape, because
  // a signature that parses and does not verify is the failure that looks like
  // success.
  it("signs an App JWT with the App's own key", () => {
    const now = Date.now();
    const jwt = appJwt(pem, "9090", now);
    const [header, payload, signature] = jwt.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);

    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as {
      iss: string;
      iat: number;
      exp: number;
    };
    expect(claims.iss).toBe("9090");
    // Backdated, because GitHub rejects a token issued in its own future and a
    // server whose clock is a few seconds fast is the ordinary case.
    expect(claims.iat).toBeLessThan(Math.floor(now / 1000));
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  });

  it("mints an installation token once and reuses it until it is nearly expired", async () => {
    const state = await stateFromForm();
    await get(`/api/adp/github-app/callback?code=abc123&state=${encodeURIComponent(state)}`, false);
    upstreamCalls = [];

    const first = await installationToken(db, CREDENTIAL_KEY, "555", fetchImpl);
    const second = await installationToken(db, CREDENTIAL_KEY, "555", fetchImpl);
    expect(first).toBe("ghs_installation_token");
    expect(second).toBe(first);
    expect(upstreamCalls.filter((c) => c.url.includes("/access_tokens"))).toHaveLength(1);
    // Authenticated with the App JWT, which is the only thing that can mint one.
    expect(upstreamCalls[0]!.auth).toMatch(/^Bearer eyJ/);
  });

  // The App delivers every installation's events to one endpoint, so unlike the
  // per-repository webhook — whose URL names the ADP repo — this path has to
  // find its way back from `repository.full_name`.
  it("routes an App delivery to the mirrored repository it names, and ingests it", async () => {
    const state = await stateFromForm();
    await get(`/api/adp/github-app/callback?code=abc123&state=${encodeURIComponent(state)}`, false);

    const name = "app-routed-repo";
    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${name}/mirror`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        remote_url: `https://github.com/upstream-org/${upstreamRepo}.git`,
        direction: "inbound",
        credential: "unused",
      }),
    });

    const payload = JSON.stringify({
      action: "opened",
      installation: { id: 555, account: { login: "upstream-org" } },
      repository: {
        full_name: `upstream-org/${upstreamRepo}`,
        html_url: `https://github.com/upstream-org/${upstreamRepo}`,
      },
      pull_request: {
        number: 7,
        title: "Through the App",
        state: "open",
        html_url: `https://github.com/upstream-org/${upstreamRepo}/pull/7`,
        head: { ref: "f", sha: "a".repeat(40) },
        base: { ref: "main" },
        user: { id: 4242, login: "app-opener", type: "User" },
      },
    });
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github/app`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request",
        "X-Hub-Signature-256":
          "sha256=" + createHmac("sha256", "app-webhook-secret").update(payload).digest("hex"),
      },
      body: payload,
    });
    expect(await res.json()).toMatchObject({ ok: true, recorded: "proposal#7" });

    const repo = (await findRepo(db, owner, name))!;
    const [proposal] = await db.select().from(proposals).where(eq(proposals.repoId, repo.id));
    expect(proposal!.number).toBe(7);
    expect(proposal!.upstreamNumber).toBe(7);
  });

  it("rejects an App delivery whose signature does not verify", async () => {
    const state = await stateFromForm();
    await get(`/api/adp/github-app/callback?code=abc123&state=${encodeURIComponent(state)}`, false);

    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github/app`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request",
        "X-Hub-Signature-256": "sha256=" + "0".repeat(64),
      },
      body: JSON.stringify({ action: "opened" }),
    });
    expect(res.status).toBe(401);
  });

  // "Uninstalling is clean" means ADP stops receiving events — not that the
  // record of what it ingested while installed disappears.
  it("records an installation and marks it gone on uninstall, keeping the row", async () => {
    const state = await stateFromForm();
    await get(`/api/adp/github-app/callback?code=abc123&state=${encodeURIComponent(state)}`, false);

    const deliver = async (action: string) => {
      const payload = JSON.stringify({
        action,
        installation: { id: 555, account: { login: "upstream-org" } },
      });
      return fetch(`http://127.0.0.1:${port}/webhooks/github/app`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "installation",
          "X-Hub-Signature-256":
            "sha256=" + createHmac("sha256", "app-webhook-secret").update(payload).digest("hex"),
        },
        body: payload,
      });
    };

    expect(await (await deliver("created")).json()).toMatchObject({ installation: "recorded" });
    const [installed] = await db.select().from(githubAppInstallations);
    expect(installed!.account).toBe("upstream-org");
    expect(installed!.suspendedAt).toBeNull();

    expect(await (await deliver("deleted")).json()).toMatchObject({ installation: "suspended" });
    const rows = await db.select().from(githubAppInstallations);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.suspendedAt).not.toBeNull();

    // Adding it back revives the same row rather than growing a second.
    await deliver("created");
    const revived = await db.select().from(githubAppInstallations);
    expect(revived).toHaveLength(1);
    expect(revived[0]!.suspendedAt).toBeNull();
  });

  it("says where to start rather than only that there is no App", async () => {
    const res = await get("/api/adp/github-app");
    expect(res.status).toBe(404);
    expect((await res.json()) as { adp_equivalent: string }).toMatchObject({
      adp_equivalent: expect.stringContaining("/github-app/new"),
    });
  });
});
