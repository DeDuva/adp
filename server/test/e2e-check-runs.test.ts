import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { generateKeyPairSync, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { skipWithoutDb } from "./require-db.js";
import { changes, githubAppInstallations, githubApps, identities, intents, issues } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerMirrorRoutes } from "../src/http-rest/mirrors.js";
import { registerMirrorWebhookRoutes, registerMirrorWebhookRawBodyParser } from "../src/http-rest/mirror-webhook.js";
import { registerGitHubAppRoutes } from "../src/http-rest/github-app.js";
import { resetInstallationTokenCache } from "../src/core/github-app.js";
import { findRepo } from "../src/core/repos-lookup.js";

const CREDENTIAL_KEY = "e2e-check-runs-credential-key";
const SIGNING_KEY = "e2e-check-runs-signing-key";
const PUBLIC_URL = "https://adp.example.com";

// #233 — `ADP / change record`, on the pull request.
//
// Everything this phase built is invisible to a developer who never leaves
// GitHub: the intent the change is bound to, the trajectory that produced it,
// the signed evidence behind the verdict. A check run is where GitHub already
// looks, and this is the whole additive claim made visible.
//
// It is deliberately never a verdict. `success` says a signed change record
// exists and `neutral` says none does yet, and both pass if somebody marks it
// required — the check that is allowed to block is 5-11's.
describe.skipIf(skipWithoutDb)("#233: the change-record check run", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  let identityId: string;
  const owner = `check-run-owner-${Date.now()}`;
  const run = Date.now();
  const upstreamOwner = `upstream-${run}`;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  // The fake api.github.com. Records every check-run write so the test asserts
  // on what GitHub would have been told rather than on a 200.
  let checkWrites: { method: string; url: string; body: Record<string, unknown> }[] = [];
  let existingCheckId: number | null = null;

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/app-manifests/")) {
      return json({
        id: 9090,
        slug: "adp-example",
        name: "ADP",
        html_url: "https://github.com/apps/adp-example",
        client_id: "Iv1.abc",
        client_secret: "s",
        pem,
        webhook_secret: "app-webhook-secret",
      });
    }
    if (url.includes("/access_tokens")) {
      return json({ token: "ghs_tok", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    }
    if (url.includes("/check-runs?check_name=") || /\/commits\/.*\/check-runs/.test(url)) {
      return json({ check_runs: existingCheckId ? [{ id: existingCheckId }] : [] });
    }
    if (url.includes("/check-runs")) {
      checkWrites.push({ method, url, body: JSON.parse(String(init?.body ?? "{}")) });
      return json({ id: 4242 }, method === "POST" ? 201 : 200);
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-check-runs-"));
    const gitBackend = new GitBackend(gitRoot);
    const signer = new Signer(SIGNING_KEY);

    app = Fastify({ logger: false });
    registerMirrorWebhookRawBodyParser(app);
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, PUBLIC_URL);
    registerMirrorRoutes(app, db, CREDENTIAL_KEY);
    registerMirrorWebhookRoutes(app, db, gitBackend, signer, CREDENTIAL_KEY, PUBLIC_URL, fetchImpl);
    registerGitHubAppRoutes(app, db, gitBackend, signer, CREDENTIAL_KEY, PUBLIC_URL, fetchImpl);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `check-run-e2e-${Date.now()}` })
      .returning();
    identityId = identity!.id;
    token = await mintToken(db, identityId, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identityId, owner);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.delete(githubAppInstallations);
    await db.delete(githubApps);
    resetInstallationTokenCache();
    checkWrites = [];
    existingCheckId = null;
  });

  async function installApp(account: string) {
    const form = await fetch(`http://127.0.0.1:${port}/github-app/new`);
    const state = decodeURIComponent(/state=([^"]+)"/.exec(await form.text())![1]!);
    await fetch(`http://127.0.0.1:${port}/api/adp/github-app/callback?code=c&state=${encodeURIComponent(state)}`);
    const [row] = await db.select().from(githubApps);
    await db
      .insert(githubAppInstallations)
      .values({ appId: row!.id, installationId: "555", account });
  }

  async function seed(name: string, upstreamRepo: string) {
    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const mirrored = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${name}/mirror`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        remote_url: `https://github.com/${upstreamOwner}/${upstreamRepo}.git`,
        direction: "inbound",
        credential: "unused",
      }),
    });
    const { webhook_secret } = (await mirrored.json()) as { webhook_secret: string };
    return { repo: (await findRepo(db, owner, name))!, webhook_secret };
  }

  function deliverPull(name: string, secret: string, headSha: string) {
    const payload = JSON.stringify({
      action: "opened",
      pull_request: {
        number: 482,
        title: "Gate the job lease",
        state: "open",
        html_url: `https://github.com/${upstreamOwner}/x/pull/482`,
        head: { ref: "fix/92", sha: headSha },
        base: { ref: "main" },
        user: { id: 4242, login: `opener-${run}`, type: "User" },
      },
    });
    return fetch(`http://127.0.0.1:${port}/webhooks/github/${owner}/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request",
        "X-Hub-Signature-256": "sha256=" + createHmac("sha256", secret).update(payload).digest("hex"),
      },
      body: payload,
    });
  }

  it("publishes what ADP knows about the commit, and links the evidence bundle", async () => {
    await installApp(upstreamOwner);
    const headSha = "a".repeat(40);
    const { repo, webhook_secret } = await seed("record-repo", "record-repo");

    // A signed change record and the intent it is bound to, exactly as an
    // ingested push and issue would leave them.
    const [intent] = await db
      .insert(intents)
      .values({
        repoId: repo.id,
        title: "Gate job lease is not enforced",
        source: "issue",
        upstreamHost: "github.com",
        upstreamNumber: 92,
        upstreamUrl: `https://github.com/${upstreamOwner}/x/issues/92`,
      })
      .returning();
    await db.insert(issues).values({
      repoId: repo.id,
      number: 92,
      title: "Gate job lease is not enforced",
      authorId: identityId,
      intentId: intent!.id,
    });
    await db.insert(changes).values({
      repoId: repo.id,
      gitSha: headSha,
      intentId: intent!.id,
      provenance: { kind: "agent", principal: "github:someone", via: "mirror-inbound", model: "claimed-model" },
      signature: "sig",
    });

    await deliverPull("record-repo", webhook_secret, headSha);

    expect(checkWrites).toHaveLength(1);
    const write = checkWrites[0]!;
    expect(write.method).toBe("POST");
    expect(write.body).toMatchObject({
      name: "ADP / change record",
      head_sha: headSha,
      status: "completed",
      // Never a verdict: `success` says a record exists, and 5-11's check is
      // the one allowed to block.
      conclusion: "success",
      details_url: `${PUBLIC_URL}/api/adp/repos/${owner}/record-repo/evidence/${headSha}`,
    });

    const summary = (write.body.output as { summary: string }).summary;
    expect(summary).toContain("Gate job lease is not enforced");
    expect(summary).toContain("github:someone");
    // The token's claim, labelled as a claim — #231's honesty, carried onto
    // the surface a developer actually reads.
    expect(summary).toContain("asserted by the harness rather than observed");
    expect(summary).toContain("Full evidence bundle");
  });

  // The state the whole product is about noticing, and therefore the one the
  // summary must not quietly omit.
  it("says a commit is bound to no intent rather than leaving the line out", async () => {
    await installApp(upstreamOwner);
    const headSha = "b".repeat(40);
    const { repo, webhook_secret } = await seed("unbound-repo", "unbound-repo");
    await db.insert(changes).values({
      repoId: repo.id,
      gitSha: headSha,
      provenance: { kind: "human", principal: "github:someone", via: "mirror-inbound" },
      signature: "sig",
    });

    await deliverPull("unbound-repo", webhook_secret, headSha);
    const summary = (checkWrites[0]!.body.output as { summary: string }).summary;
    expect(summary).toContain("carries no `ADP-Intent` trailer");
  });

  it("reports neutral, not failure, when no change record exists yet", async () => {
    await installApp(upstreamOwner);
    const { webhook_secret } = await seed("neutral-repo", "neutral-repo");

    await deliverPull("neutral-repo", webhook_secret, "c".repeat(40));
    expect(checkWrites[0]!.body).toMatchObject({ conclusion: "neutral" });
    expect((checkWrites[0]!.body.output as { summary: string }).summary).toContain("never blocks a merge");
  });

  // GitHub keeps every check run of the same name on a commit and shows the
  // newest, so appending works and leaves a pile of stale rows a reader has to
  // scroll past to reach the one that is true.
  it("updates the check run already on the commit rather than appending another", async () => {
    await installApp(upstreamOwner);
    const { webhook_secret } = await seed("update-repo", "update-repo");
    existingCheckId = 777;

    await deliverPull("update-repo", webhook_secret, "d".repeat(40));
    expect(checkWrites).toHaveLength(1);
    expect(checkWrites[0]!.method).toBe("PATCH");
    expect(checkWrites[0]!.url).toContain("/check-runs/777");
  });

  // An instance still on the personal-access-token path publishes nothing and
  // says why. The record is complete either way; a check run is a view of it.
  it("skips publishing, without failing the ingest, when the instance has no App", async () => {
    const { webhook_secret } = await seed("no-app-repo", "no-app-repo");

    const res = await deliverPull("no-app-repo", webhook_secret, "e".repeat(40));
    const body = (await res.json()) as { recorded?: string; checks?: { published: boolean; reason: string }[] };
    expect(body.recorded).toBe("proposal#482");
    expect(body.checks![0]).toMatchObject({
      published: false,
      reason: expect.stringContaining("a personal access token cannot create them"),
    });
    expect(checkWrites).toHaveLength(0);
  });

  it("skips a repository whose owner has not installed the App", async () => {
    await installApp("somebody-else");
    const { webhook_secret } = await seed("uninstalled-repo", "uninstalled-repo");

    const res = await deliverPull("uninstalled-repo", webhook_secret, "f".repeat(40));
    const body = (await res.json()) as { checks?: { reason: string }[] };
    expect(body.checks![0]!.reason).toContain(`not installed on ${upstreamOwner}`);
  });
});
