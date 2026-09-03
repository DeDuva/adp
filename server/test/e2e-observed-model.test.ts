import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { skipWithoutDb } from "./require-db.js";
import { changes, identities, sessions } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { findRepo } from "../src/core/repos-lookup.js";
import { getEvidenceBundle } from "../src/core/evidence.js";
import { appendEvents } from "../src/core/trajectory.js";
import { modelFor } from "../src/core/observed-model.js";

// #231 — which model produced a change, observed rather than asserted.
//
// `provenance.model` comes from the token, which took it from whatever
// `adp connect` or the mint call said once, at connect time. A harness can
// change model inside a single run, and `session_events.model` has recorded it
// per event since the trajectory slice landed, because that was anticipated.
// So the field ADP published as "which model produced this" was an assertion,
// while the observation sat in the trajectory unread.
//
// The assertion is not deleted and the observation does not replace it in the
// signed record: a change is signed at push time and the trajectory arrives out
// of band, so signing an observation not yet made is not available. What is
// available is both facts and a label saying which is load bearing — and the
// label is the point, because showing the weaker fact is fine and showing it as
// though it were the stronger one is not.
describe.skipIf(skipWithoutDb)("#231: the model is observed, not asserted", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  let identityId: string;
  let signer: Signer;
  const owner = `observed-model-owner-${Date.now()}`;

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-observed-model-"));
    const gitBackend = new GitBackend(gitRoot);
    signer = new Signer("e2e-observed-model-signing-key");

    app = Fastify({ logger: false });
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, "https://adp.example.com");
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const [identity] = await db
      .insert(identities)
      .values({ kind: "agent", principal: `observed-model-e2e-${Date.now()}` })
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

  async function seed(name: string) {
    const res = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(201);
    return (await findRepo(db, owner, name))!;
  }

  // A change recorded exactly as a push records one, plus a session whose
  // trajectory says what actually ran. The sha is arbitrary: nothing here
  // reads git, only the joins.
  async function record(
    repoId: string,
    sha: string,
    assertedModel: string | null,
    observedModels: string[],
  ) {
    const provenance = {
      kind: "agent",
      principal: "agent",
      via: "push",
      ...(assertedModel ? { model: assertedModel } : {}),
    };
    await db.insert(changes).values({
      repoId,
      gitSha: sha,
      provenance,
      signature: signer.sign({ repo: "x", git_sha: sha, intent_id: null, provenance }),
    });

    if (observedModels.length === 0) return;
    const [session] = await db
      .insert(sessions)
      .values({ repoId, harness: "claude-code", actorId: identityId })
      .returning();

    // Through the real append rather than by inserting rows: the trajectory is
    // hash-chained, and a test that writes its own rows is a test that stops
    // exercising the chain the moment the chain changes.
    const result = await appendEvents(db, repoId, session!.id, [
      ...observedModels.map((model) => ({ kind: "model_call" as const, model, payload: {} })),
      // The commit event is how the trajectory names the change it produced —
      // a typed column, so the join needs no payload parsing.
      { kind: "commit" as const, gitSha: sha, payload: {} },
    ]);
    expect(result.ok).toBe(true);
  }

  it("names the model observed in the trajectory rather than the one the token claimed", async () => {
    const repo = await seed("observed-repo");
    const sha = "1".repeat(40);
    // The token said one thing at connect time; the trajectory recorded
    // another. The observation is what a reader is shown.
    await record(repo.id, sha, "asserted-at-connect-time", ["really-ran-v2"]);

    const bundle = await getEvidenceBundle(db, repo.id, sha);
    expect(bundle.produced_by.models).toMatchObject({
      observed: ["really-ran-v2"],
      asserted: "asserted-at-connect-time",
      source: "observed",
    });
  });

  // The case the whole item exists for, and the one a single value erases.
  it("represents a run whose model changed as a sequence rather than collapsing it", async () => {
    const repo = await seed("changed-repo");
    const sha = "2".repeat(40);
    await record(repo.id, sha, "claimed-one-model", ["first-model", "second-model", "first-model"]);

    const bundle = await getEvidenceBundle(db, repo.id, sha);
    // In first-seen order, and de-duplicated: the fact is which models ran,
    // not how many calls each made.
    expect(bundle.produced_by.models.observed).toEqual(["first-model", "second-model"]);
    expect(bundle.produced_by.models.source).toBe("observed");
  });

  // The documented degraded mode — a harness with no reader — said out loud
  // rather than passed off as an observation.
  it("falls back to the asserted model and says that is what it is showing", async () => {
    const repo = await seed("asserted-repo");
    const sha = "3".repeat(40);
    await record(repo.id, sha, "only-ever-claimed", []);

    const bundle = await getEvidenceBundle(db, repo.id, sha);
    expect(bundle.produced_by.models).toMatchObject({
      observed: [],
      asserted: "only-ever-claimed",
      source: "asserted",
    });
  });

  it("says neither, rather than nothing, for a commit a person wrote", async () => {
    const repo = await seed("neither-repo");
    const sha = "4".repeat(40);
    await record(repo.id, sha, null, []);

    const bundle = await getEvidenceBundle(db, repo.id, sha);
    expect(bundle.produced_by.models).toMatchObject({ observed: [], asserted: null, source: "none" });
  });

  // `session_events` has no repo column, and the sha is caller input. An
  // unscoped join would let a sha that exists in two repositories report the
  // other one's models — the same trap producedByFor's session lookup avoids.
  it("does not read another repository's trajectory for the same sha", async () => {
    const mine = await seed("scoped-mine");
    const theirs = await seed("scoped-theirs");
    const sha = "5".repeat(40);
    await record(theirs.id, sha, null, ["their-model"]);
    await record(mine.id, `${sha.slice(0, 39)}a`, null, []);

    const [session] = await db.select().from(sessions).where(eq(sessions.repoId, theirs.id));
    const leaked = await modelFor(db, mine.id, [session!.id], null);
    expect(leaked.observed).toEqual([]);
  });
});
