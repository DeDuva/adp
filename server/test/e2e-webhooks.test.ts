import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type Db } from "../src/db/client.js";
import { identities } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerProposalRoutes } from "../src/http-rest/proposals.js";
import { registerGateRoutes } from "../src/http-rest/gates.js";
import { registerWebhookRoutes } from "../src/http-rest/webhooks.js";
import { Signer } from "../src/core/signing.js";

const execFileAsync = promisify(execFile);

interface ReceivedDelivery {
  event: string | undefined;
  signature: string | undefined;
  bodyText: string;
}

// M2: outbound webhook emitter (docs/pragmatic_mvp.md) — a real HTTP
// receiver on loopback stands in for a subscriber, so this exercises actual
// delivery (signing, headers, payload shape), not just that emitWebhookEvent
// was called (core/webhooks.test.ts covers the retry/filtering logic itself).
describe.skipIf(skipWithoutDb)("M2: outbound webhook emitter", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  let receiver: Server;
  let receiverPort: number;
  let deliveries: ReceivedDelivery[];
  const owner = `webhooks-owner-${Date.now()}`;
  const secret = "whsec-test-secret";

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    ({ db, pool } = createDb(databaseUrl));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    deliveries = [];
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        deliveries.push({
          event: req.headers["x-adp-event"] as string | undefined,
          signature: req.headers["x-hub-signature-256"] as string | undefined,
          bodyText: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200);
        res.end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const receiverAddress = receiver.address();
    receiverPort = typeof receiverAddress === "object" && receiverAddress ? receiverAddress.port : 0;

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-webhooks-git-"));
    const gitBackend = new GitBackend(gitRoot);
    const signer = new Signer("e2e-webhooks-signing-key");

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    const credentialKey = "e2e-webhooks-credential-key";
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    registerProposalRoutes(app, db, gitBackend, credentialKey);
    registerGateRoutes(app, db, signer, "http://localhost", credentialKey);
    registerWebhookRoutes(app, db, credentialKey);
    registerGitHttpRoutes(app, gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `webhooks-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  });

  it("delivers a signed pull_request and gate_result event to a subscribed endpoint", async () => {
    const repoName = "widget";
    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: repoName }),
    });

    const hookRes = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/hooks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        events: ["pull_request", "gate_result"],
        config: { url: `http://127.0.0.1:${receiverPort}/hook`, secret },
      }),
    });
    expect(hookRes.status).toBe(201);
    const hook = (await hookRes.json()) as { id: string; config: { url: string } };
    expect(hook.config.url).toBe(`http://127.0.0.1:${receiverPort}/hook`);

    // A second, unrelated subscription (push only) should never fire below —
    // proving delivery is filtered by event type, not broadcast to every hook.
    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/hooks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        events: ["push"],
        config: { url: `http://127.0.0.1:${receiverPort}/hook-should-not-fire`, secret: "irrelevant" },
      }),
    });

    const cloneDir = await mkdtemp(path.join(tmpdir(), "adp-e2e-webhooks-clone-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, cloneDir]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo hi > README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo more >> README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-am", "feature commit"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "feature"], { cwd: cloneDir });
    const headSha = (await execFileAsync("git", ["rev-parse", "feature"], { cwd: cloneDir })).stdout.trim();
    await rm(cloneDir, { recursive: true, force: true });

    const prRes = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/pulls`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Add more", head: "feature", base: "main" }),
    });
    expect(prRes.status).toBe(201);

    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/gates`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ git_sha: headSha, name: "test", status: "success", summary: "12 passed" }),
    });

    // emitWebhookEvent is fire-and-forget from the caller's perspective.
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(deliveries).toHaveLength(2);
    expect(deliveries.some((d) => d.event === "push")).toBe(false);

    const prDelivery = deliveries.find((d) => d.event === "pull_request");
    expect(prDelivery).toBeTruthy();
    const expectedPrSig = `sha256=${createHmac("sha256", secret).update(prDelivery!.bodyText).digest("hex")}`;
    expect(prDelivery!.signature).toBe(expectedPrSig);
    const prPayload = JSON.parse(prDelivery!.bodyText) as { action: string; pull_request: { title: string } };
    expect(prPayload.action).toBe("opened");
    expect(prPayload.pull_request.title).toBe("Add more");

    const gateDelivery = deliveries.find((d) => d.event === "gate_result");
    expect(gateDelivery).toBeTruthy();
    const gatePayload = JSON.parse(gateDelivery!.bodyText) as { git_sha: string; status: string };
    expect(gatePayload.git_sha).toBe(headSha);
    expect(gatePayload.status).toBe("success");
  });

  it("REST hook management: list, get, and delete round-trip; secret is never echoed back", async () => {
    const repoName = "widget2";
    await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: repoName }),
    });

    const created = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/hooks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ events: ["push"], config: { url: "http://example.invalid/hook", secret: "shh" } }),
    });
    const hook = (await created.json()) as Record<string, unknown>;
    expect(hook.secret).toBeUndefined();
    expect((hook.config as { secret?: string }).secret).toBeUndefined();

    const list = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/hooks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(((await list.json()) as unknown[]).length).toBe(1);

    const get = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/hooks/${hook.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(get.status).toBe(200);

    const del = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/hooks/${hook.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(del.status).toBe(204);

    const afterDelete = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${repoName}/hooks/${hook.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(afterDelete.status).toBe(404);
  });
});
