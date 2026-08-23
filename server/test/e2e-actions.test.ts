import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq, and } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { skipWithoutDb } from "./require-db.js";
import { gateResults, identities, mirrors, operations, repos } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerMirrorRoutes } from "../src/http-rest/mirrors.js";
import { registerMirrorWebhookRoutes, registerMirrorWebhookRawBodyParser } from "../src/http-rest/mirror-webhook.js";
import { registerActionsRoutes } from "../src/http-rest/actions.js";
import { verifyEnvelope, decodeStatement, type DsseEnvelope } from "../src/core/dsse.js";

const CREDENTIAL_KEY = "e2e-actions-credential-key";
const SIGNING_KEY = "e2e-actions-signing-key";
const PUBLIC_URL = "https://adp.example.com";

// M2: the two halves of "Actions in mirror mode".
//
//   ingest      — a completed upstream workflow_run becomes signed gate
//                 evidence. This is the *only* writer.
//   passthrough — read-only Actions endpoints relay upstream for a mirrored
//                 repo, 404 self-describingly for a non-mirrored one, and
//                 never fabricate a result when upstream is unreachable.
//
// The exit criterion this file exists to prove is "exactly one evidence row
// per completed upstream run" — so redelivery, which GitHub does routinely,
// gets its own case.
describe.skipIf(skipWithoutDb)("M2: Actions ingest + passthrough", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  // Requests the fake upstream saw, so the relay can be asserted on rather
  // than inferred from a 200.
  let upstreamCalls: { url: string; auth: string | null }[] = [];
  let upstreamHandler: (url: string) => { status: number; body: string } | Promise<never>;
  const owner = `actions-owner-${Date.now()}`;

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-actions-"));
    const gitBackend = new GitBackend(gitRoot);
    const signer = new Signer(SIGNING_KEY);

    // Stands in for api.github.com. Injected rather than intercepted so the
    // test never depends on the network or on a live GitHub token.
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      upstreamCalls.push({
        url,
        auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null,
      });
      const out = await upstreamHandler(url);
      return new Response(out.body, { status: out.status, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    app = Fastify({ logger: false });
    registerMirrorWebhookRawBodyParser(app);
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, PUBLIC_URL);
    registerMirrorRoutes(app, db, CREDENTIAL_KEY);
    registerMirrorWebhookRoutes(app, db, gitBackend, signer, CREDENTIAL_KEY, PUBLIC_URL);
    registerActionsRoutes(app, db, CREDENTIAL_KEY, fakeFetch);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "human", principal: `actions-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  async function createRepo(name: string) {
    const res = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  }

  async function createMirror(name: string) {
    const res = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${name}/mirror`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        remote_url: "https://github.com/upstream-org/upstream-repo.git",
        direction: "inbound",
        credential: "upstream-pat",
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { webhook_secret: string };
  }

  function deliver(name: string, secret: string, event: string, payload: unknown) {
    const body = JSON.stringify(payload);
    return fetch(`http://127.0.0.1:${port}/webhooks/github/${owner}/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": event,
        "X-Hub-Signature-256": "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
      },
      body,
    });
  }

  function runPayload(overrides: Record<string, unknown> = {}) {
    return {
      action: "completed",
      workflow_run: {
        id: 5001,
        name: "CI",
        head_sha: "a".repeat(40),
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/upstream-org/upstream-repo/actions/runs/5001",
        run_number: 7,
        event: "push",
        ...overrides,
      },
    };
  }

  it("ingests a completed workflow_run as signed gate evidence", async () => {
    const name = "ingest-repo";
    const repo = await createRepo(name);
    const { webhook_secret } = await createMirror(name);

    const res = await deliver(name, webhook_secret, "workflow_run", runPayload());
    expect(res.status).toBe(200);
    expect((await res.json()) as { recorded?: string }).toMatchObject({ recorded: "actions/CI" });

    const rows = await db
      .select()
      .from(gateResults)
      .where(and(eq(gateResults.repoId, repo.id), eq(gateResults.name, "actions/CI")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("success");
    expect(rows[0]!.gitSha).toBe("a".repeat(40));
    expect(rows[0]!.externalId).toBe("workflow_run:5001");

    // Signed like every other gate, and carrying enough for a verifier to tell
    // relayed upstream evidence from something observed here.
    const envelope = rows[0]!.envelope as DsseEnvelope;
    expect(verifyEnvelope(new Signer(SIGNING_KEY), envelope)).toBe(true);
    const statement = decodeStatement(envelope);
    expect(statement.predicateType).toBe("https://adp.dev/attestations/upstream-workflow-run/v1");
    expect(statement.predicate).toMatchObject({ provider: "github-actions", runId: 5001, ingestedVia: "mirror-webhook" });

    const ops = await db
      .select()
      .from(operations)
      .where(and(eq(operations.repoId, repo.id), eq(operations.verb, "gate.ingest")));
    expect(ops).toHaveLength(1);
  });

  // The M2 exit criterion, stated literally: "exactly one evidence row exists
  // per completed upstream run". GitHub redelivers webhooks routinely, so this
  // is a real condition rather than a theoretical one.
  it("records exactly one evidence row when GitHub redelivers the same run", async () => {
    const name = "redeliver-repo";
    const repo = await createRepo(name);
    const { webhook_secret } = await createMirror(name);

    const first = await deliver(name, webhook_secret, "workflow_run", runPayload({ id: 6001 }));
    expect((await first.json()) as { recorded?: string }).toMatchObject({ recorded: "actions/CI" });

    const second = await deliver(name, webhook_secret, "workflow_run", runPayload({ id: 6001 }));
    const secondBody = (await second.json()) as { skipped?: string };
    expect(second.status).toBe(200);
    expect(secondBody.skipped).toContain("duplicate delivery");

    const rows = await db
      .select()
      .from(gateResults)
      .where(and(eq(gateResults.repoId, repo.id), eq(gateResults.externalId, "workflow_run:6001")));
    expect(rows).toHaveLength(1);
  });

  it("maps a failed run to a failing gate, and ignores non-completed actions", async () => {
    const name = "conclusion-repo";
    const repo = await createRepo(name);
    const { webhook_secret } = await createMirror(name);

    const inProgress = await deliver(name, webhook_secret, "workflow_run", {
      action: "in_progress",
      workflow_run: { id: 7001, name: "CI", head_sha: "b".repeat(40) },
    });
    expect((await inProgress.json()) as { skipped?: string }).toMatchObject({ skipped: "ignored action 'in_progress'" });

    await deliver(name, webhook_secret, "workflow_run", runPayload({ id: 7002, conclusion: "timed_out", name: "Nightly" }));

    const rows = await db.select().from(gateResults).where(eq(gateResults.repoId, repo.id));
    expect(rows).toHaveLength(1);
    // "timed_out" is a failure, not pending — a run that stopped without
    // succeeding must block a gates_green land policy rather than hold it open.
    expect(rows[0]!.status).toBe("failure");
    expect(rows[0]!.name).toBe("actions/Nightly");
  });

  it("relays GET actions/runs upstream for a mirrored repo, without recording anything", async () => {
    const name = "relay-repo";
    const repo = await createRepo(name);
    await createMirror(name);
    upstreamCalls = [];
    upstreamHandler = () => ({ status: 200, body: JSON.stringify({ total_count: 1, workflow_runs: [{ id: 42 }] }) });

    const res = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${name}/actions/runs?per_page=5`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { workflow_runs: unknown[] }).toMatchObject({ total_count: 1 });

    // Relayed to the *upstream* coordinates, with the mirror credential and
    // the caller's query string preserved.
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]!.url).toBe(
      "https://api.github.com/repos/upstream-org/upstream-repo/actions/runs?per_page=5",
    );
    expect(upstreamCalls[0]!.auth).toBe("Bearer upstream-pat");

    // Relay, do not record: the evidence plane keeps exactly one writer, and
    // it is the ingest path, not the proxy.
    expect(await db.select().from(gateResults).where(eq(gateResults.repoId, repo.id))).toHaveLength(0);
    expect(await db.select().from(operations).where(and(eq(operations.repoId, repo.id), eq(operations.verb, "gate.ingest")))).toHaveLength(0);
  });

  it("relays run detail and jobs, and keeps write paths unimplemented", async () => {
    const name = "detail-repo";
    await createRepo(name);
    await createMirror(name);
    upstreamCalls = [];
    upstreamHandler = () => ({ status: 200, body: JSON.stringify({ ok: true }) });

    for (const [suffix, expected] of [
      ["/actions/runs/99", "/actions/runs/99"],
      ["/actions/runs/99/jobs", "/actions/runs/99/jobs"],
      ["/actions/workflows", "/actions/workflows"],
    ] as const) {
      const res = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${name}${suffix}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect(upstreamCalls.at(-1)!.url).toBe(`https://api.github.com/repos/upstream-org/upstream-repo${expected}`);
    }

    // No dispatch / re-run / cancel: a write would make ADP responsible for an
    // execution model it deliberately does not have.
    const rerun = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${name}/actions/runs/99/rerun`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(rerun.status).toBe(404);
  });

  it("returns a self-describing 404 for a non-mirrored repo", async () => {
    const name = "plain-repo";
    await createRepo(name);

    const res = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${name}/actions/runs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { adp_equivalent?: string };
    // A broken call that explains itself costs an agent one turn (§2.4).
    expect(body.adp_equivalent).toContain("adp.yaml");
    expect(body.adp_equivalent).toContain("/gates");
    // ...but only if the endpoint it names is real. This body used to point at
    // `/commits/{ref}/check-runs`, which this server has never served, so the
    // self-describing 404 cost an agent two turns instead of saving it one.
    expect(body.adp_equivalent).toContain("/commits/{sha}/gates");
    expect(body.adp_equivalent).not.toContain("check-runs");
  });

  // A disabled mirror is the operator saying "stop talking to GitHub for this
  // repo". mirror-webhook.ts has always honoured that on ingest; the relay used
  // to decrypt and forward the PAT upstream anyway, which left "disabled"
  // meaning two different things in two files.
  it("stops relaying once the mirror is disabled, without ever calling upstream", async () => {
    const name = "disabled-mirror-repo";
    await createRepo(name);
    await createMirror(name);

    let upstreamCalls = 0;
    upstreamHandler = () => {
      upstreamCalls++;
      return { status: 200, body: '{"total_count":0,"workflow_runs":[]}' };
    };

    const enabledRes = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${name}/actions/runs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(enabledRes.status).toBe(200);
    expect(upstreamCalls).toBe(1);

    const [repo] = await db.select().from(repos).where(and(eq(repos.owner, owner), eq(repos.name, name)));
    await db.update(mirrors).set({ enabled: false }).where(eq(mirrors.repoId, repo!.id));

    const res = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${name}/actions/runs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { adp_equivalent?: string };
    expect(body.adp_equivalent).toContain("adp.yaml");
    // The point isn't the status code, it's that the credential never left the
    // box: a 404 that still made the upstream call would be the same leak.
    expect(upstreamCalls).toBe(1);
  });

  it("returns 502 when upstream fails, never a fabricated empty run list", async () => {
    const name = "upstream-down-repo";
    await createRepo(name);
    await createMirror(name);

    upstreamHandler = () => ({ status: 503, body: '{"message":"Service Unavailable"}' });
    const errored = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${name}/actions/runs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(errored.status).toBe(502);
    const body = (await errored.json()) as { upstream_status?: number; workflow_runs?: unknown[] };
    expect(body.upstream_status).toBe(503);
    // The worst outcome available here is an agent believing CI passed because
    // the proxy invented silence.
    expect(body.workflow_runs).toBeUndefined();

    upstreamHandler = () => Promise.reject(new Error("getaddrinfo ENOTFOUND api.github.com"));
    const unreachable = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}/${name}/actions/runs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(unreachable.status).toBe(502);
    expect(((await unreachable.json()) as { message: string }).message).toContain("ENOTFOUND");
  });
});
