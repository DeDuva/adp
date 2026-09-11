import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type Db } from "../src/db/client.js";
import { identities } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerApiRoutes } from "../src/routes.js";
import {
  runStorageGrowth,
  dropArmDatabase,
  CI_SCALE,
  type StorageGrowthResult,
} from "../../bench/lib/storage-growth.mjs";

// PLAN.md 3-5 (#195), arm 4: the storage-growth benchmark, enforced in CI at
// small N.
//
// This drives `bench/lib/storage-growth.mjs` — the exact code the published
// benchmark runs, not a reimplementation of it — for the reason arm 1's test
// gives: a check that exercises a different implementation from the one that
// produced the published numbers checks nothing that matters.
//
// It runs against a database of its own, created here and dropped afterwards.
// The arm measures relation sizes, which are per table rather than per tenant,
// and refuses to run on a database anyone else is writing to — which the rest
// of the e2e tier, running concurrently against the shared one, always is.
//
// The assertions are about *accounting*, never about a size or a speed. No
// byte count is pinned, because one moves with the Postgres version and the
// page layout; no latency is, because a threshold that fails on a loaded
// runner teaches a team to ignore it. What must hold everywhere is that every
// write the arm made is the write it counted, that the payload mode it
// reported is the one the server applied, and that the dedup arithmetic
// describes the rows that are actually there.
describe.skipIf(skipWithoutDb)("3-5: storage-growth benchmark arm", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: pg.Pool;
  let admin: pg.Pool;
  let gitRoot: string;
  let port: number;
  let token: string;
  let result: StorageGrowthResult;
  const dbName = `storage_growth_${Date.now()}_${process.pid}`;
  const owner = "bench";

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const target = new URL(process.env.DATABASE_URL!);
    target.pathname = `/${dbName}`;

    ({ db, pool } = createDb(target.toString()));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-storage-growth-git-"));
    const gitBackend = new GitBackend(gitRoot);

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    // The whole route table, as main.ts mounts it — SBOM-per-land included,
    // since that is one of the things being measured. No land-policy floor:
    // this arm measures what a land stores, not what it takes to be allowed.
    registerApiRoutes(app, {
      db,
      gitBackend,
      signer: new Signer("e2e-storage-growth-signing-key"),
      publicUrl: "https://adp.example.com",
      credentialKey: "e2e-storage-growth-credential-key",
      instanceFloor: [],
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [identity] = await db.insert(identities).values({ kind: "agent", principal: "storage-growth-e2e" }).returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);

    // In-process, so this is the test runner's RSS and not a server's alone.
    // The published run measures a real server process; here the only claim is
    // that the measurement is taken and is a number.
    let baseline = 0;
    let peak = 0;
    let timer: NodeJS.Timeout | undefined;
    const rss = {
      reset() {
        clearInterval(timer);
        baseline = process.memoryUsage().rss;
        peak = baseline;
        timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);
      },
      peak() {
        clearInterval(timer);
        return { baselineBytes: baseline, peakBytes: Math.max(peak, process.memoryUsage().rss) };
      },
    };

    result = await runStorageGrowth({
      baseUrl: `http://127.0.0.1:${port}`,
      token,
      owner,
      sql: async (text, params) => (await pool.query(text, params)).rows,
      rss,
      gitBytes: (o, r) => gitBackend.diskUsageBytes(o, r),
      scale: CI_SCALE,
    });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    // Waits for this file's own connections to leave before dropping — see
    // dropArmDatabase for the unhandled FATAL that forcing it produced in CI.
    if (admin) {
      await dropArmDatabase(async (text, params) => (await admin.query(text, params)).rows, dbName);
      await admin.end();
    }
    if (gitRoot) await rm(gitRoot, { recursive: true, force: true });
  });

  it("counts every event it appended, under the payload mode the server actually applied", () => {
    expect(result.events.map((e) => `${e.mode}/${e.profile}`)).toEqual([
      "structure/text",
      "structure/random",
      "full/text",
      "full/random",
    ]);
    for (const e of result.events) {
      expect(e.events).toBe(CI_SCALE.bytesEvents);
      expect(e.relation.rows).toBe(CI_SCALE.bytesEvents);
      // `structure` records a digest beside every payload it projected and
      // `full` records none — so this is the check that adp.yaml took effect,
      // and that a "full" row in the report is not a structure row mislabelled.
      expect(e.stored.digestedEvents).toBe(e.mode === "structure" ? e.events : 0);
      // A corpus the secret detector rewrites is a measurement of the detector.
      // The first `random` profile was base64, and #148 redacted most of it.
      expect(e.stored.redactedEvents).toBe(0);
      expect(e.relation.total).toBeGreaterThan(0);
      expect(e.stored.rowBytes).toBeGreaterThan(0);
      expect(e.dedup.distinctPayloadTextBytes).toBeLessThanOrEqual(e.dedup.payloadTextBytes);
      expect(e.compression.perEventDeflateBytes).toBeGreaterThan(0);
    }

    // The projection keeps a payload's shape and drops its strings, and these
    // payloads are mostly strings: if structure did not store less than full
    // for the same corpus, the mode would not be doing what #199 says.
    const [structureText, , fullText] = result.events;
    expect(structureText!.stored.payloadDatumBytes).toBeLessThan(fullText!.stored.payloadDatumBytes);
  });

  it("accounts for the ingest run: every batch, every checkpoint, one relation delta", () => {
    const perWriter = Math.floor(CI_SCALE.ingestEvents / CI_SCALE.writers);
    const batched = result.ingest.batches.reduce((sum, [, , n]) => sum + n, 0);
    expect(batched).toBe(perWriter * CI_SCALE.writers);
    expect(result.ingest.events).toBe(batched);
    expect(result.ingest.relation.rows).toBe(batched);
    expect(new Set(result.ingest.batches.map(([w]) => w)).size).toBe(CI_SCALE.writers);

    expect(result.checkpoints.count).toBe(result.checkpoints.latencyMs.length);
    expect(result.checkpoints.count).toBeGreaterThanOrEqual(CI_SCALE.writers);
    expect(result.checkpoints.relation.rows).toBe(result.checkpoints.count);
  });

  it("verifies the run it measured, and measures memory while doing it", () => {
    expect(result.verify.map((v) => `${v.target}:${v.coverage}`)).toEqual([
      "run:full",
      "run:from-checkpoint",
      "session:full",
    ]);
    for (const v of result.verify) {
      expect(typeof v.peakRssOverBaselineBytes).toBe("number");
      expect(v.ms).toBeGreaterThan(0);
    }
  });

  it("records one SBOM per land, and the dedup arithmetic describes those rows", () => {
    const { sbom, rows } = result.lands;
    expect(rows.gate_results.rows).toBe(CI_SCALE.lands);
    expect(rows.proposals.rows).toBe(CI_SCALE.lands);
    expect(rows.changes.rows).toBeGreaterThanOrEqual(CI_SCALE.lands);

    // Every land names its own subject sha, so no two statements are alike.
    expect(sbom.statement.documents).toBe(CI_SCALE.lands);
    expect(sbom.statement.distinctDocuments).toBe(CI_SCALE.lands);
    // #194 takes out the UUID and the clock, and that alone makes no stored
    // byte a copy: the body still names the commit it describes
    // (`metadata.component.version`), so it is still one document per land.
    // What an unchanged lockfile does make a copy is the component list — one
    // document stored N times. The report says what that is worth.
    expect(sbom.withoutSerialAndTimestamp.distinctDocuments).toBe(CI_SCALE.lands);
    expect(sbom.components.distinctDocuments).toBe(1);
    expect(sbom.components.distinctBytes * CI_SCALE.lands).toBe(sbom.components.bytes);

    expect(result.lands.gitBytes!.after).toBeGreaterThan(result.lands.gitBytes!.before);
  });

  it("puts the storage meter's row count beside what the relations occupy", () => {
    // The meter counts row datums by design (core/storage-usage.ts) and so
    // reads low: no index, no page overhead. The report says by how much;
    // this pins only the direction, which is what a quota set against the
    // meter has to allow for.
    const events = result.meter["session_events"]!;
    expect(events.rows).toBe(CI_SCALE.bytesEvents * 4 + result.ingest.events);
    expect(events.relationBytes).toBeGreaterThan(events.rowBytes);
  });
});
