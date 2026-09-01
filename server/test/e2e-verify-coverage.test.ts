import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, asc, eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { identities, sessionEvents } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { KeyRegistry, Signer } from "../src/core/signing.js";
import {
  contiguityOf,
  emitterContiguity,
  eventHash,
  verifyChain,
  VERIFY_BATCH_SIZE,
} from "../src/core/trajectory.js";
import { verifySession } from "../src/core/verification.js";
import { verifiedAnchors } from "../src/core/sessions.js";
import { registerGitHttpRoutes } from "../src/http-git/proxy.js";
import { repoAccessCheck } from "../src/core/repos-lookup.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerIssueRoutes } from "../src/http-rest/issues.js";
import { registerWorkspaceRoutes } from "../src/http-rest/workspaces.js";
import { registerSessionRoutes } from "../src/http-rest/sessions.js";
import { registerRunRoutes } from "../src/http-rest/runs.js";

const execFileAsync = promisify(execFile);
const SIGNING_KEY = "e2e-verify-coverage-signing-key";
const PUBLIC_URL = "https://adp.example.com";

// #152. Verification is the endpoint that converts the hash chain from a claim
// into a claim anyone holding a read token can falsify, so it is the last thing
// that may become unreliable at volume — and the first thing whose *coverage*
// has to be stated rather than assumed.
//
// Three properties are asserted here, in order of how easy they are to get
// wrong:
//
//   1. Reading in batches changes nothing. The batch boundary is not allowed to
//      be load-bearing, so the same chain is verified at 1, 2, 7 and the default
//      and must give one answer.
//   2. Anchoring at a signed checkpoint agrees with full verification on
//      everything after the anchor — and the tamper cases say precisely where
//      the two stop agreeing, in both directions. An incremental verifier that
//      starts too late is a verifier that misses the tampering, so "where it
//      stops agreeing" is the assertion, not a footnote to it.
//   3. Deleting the tail is caught. A truncated chain recomputes perfectly,
//      because what is gone leaves nothing behind to disagree with; the signed
//      checkpoint beyond the last stored event is the only evidence left.
describe.skipIf(skipWithoutDb)("#152: verification coverage, batching and the tamper boundary", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let signer: Signer;
  let keys: KeyRegistry;
  let port: number;
  let token: string;
  let mainSha: string;
  let runId: string;
  let sessionId: string;
  let intentId: string;
  const owner = `verify-owner-${Date.now()}`;
  const repoName = "widget";

  // The chain is 20 events with a checkpoint after the 12th, so every case
  // below has a prefix and a suffix to be wrong in.
  const TOTAL_EVENTS = 20;
  const ANCHOR_AT = 12;

  async function api(pathAndQuery: string, init: RequestInit = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body: body as Record<string, unknown> };
  }

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-e2e-verify-git-"));
    const gitBackend = new GitBackend(gitRoot);
    signer = new Signer(SIGNING_KEY);
    keys = new KeyRegistry(signer);

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      (_req, payload, done) => done(null, payload),
    );
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, PUBLIC_URL);
    registerIssueRoutes(app, db);
    registerWorkspaceRoutes(app, db, gitBackend);
    registerSessionRoutes(app, db, gitBackend, signer, PUBLIC_URL, keys);
    registerRunRoutes(app, db, gitBackend, signer, PUBLIC_URL, keys);
    registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;
    gitBackend.setInternalUrl(`http://127.0.0.1:${port}`);

    const [identity] = await db
      .insert(identities)
      .values({ kind: "agent", principal: `verify-e2e-${Date.now()}` })
      .returning();
    token = await mintToken(db, identity!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, identity!.id, owner);
    await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: repoName }) });

    const seed = await mkdtemp(path.join(tmpdir(), "adp-e2e-verify-seed-"));
    const cloneUrl = `http://x-access-token:${token}@127.0.0.1:${port}/${owner}/${repoName}.git`;
    await execFileAsync("git", ["clone", cloneUrl, seed]);
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: seed });
    await execFileAsync("git", ["config", "user.email", "seed@example.com"], { cwd: seed });
    await execFileAsync("git", ["config", "user.name", "Seed"], { cwd: seed });
    await writeFile(path.join(seed, "README.md"), "seed\n");
    await execFileAsync("git", ["add", "."], { cwd: seed });
    await execFileAsync("git", ["commit", "-m", "seed"], { cwd: seed });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: seed });
    mainSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: seed })).stdout.trim();
    await rm(seed, { recursive: true, force: true });

    const issue = await api(`/api/v3/repos/${owner}/${repoName}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: "verify a long trajectory" }),
    });
    intentId = issue.body.intent_id as string;

    const run = await api(`/api/adp/repos/${owner}/${repoName}/runs`, {
      method: "POST",
      body: JSON.stringify({ intent_id: intentId, orchestrator: "squad", external_ref: "issue:verify" }),
    });
    runId = run.body.id as string;

    const session = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code", run_id: runId }),
    });
    sessionId = session.body.id as string;

    const append = (from: number, to: number) =>
      api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionId}/events`, {
        method: "POST",
        body: JSON.stringify({
          events: Array.from({ length: to - from + 1 }, (_, i) => ({
            kind: "message",
            type: "assistant",
            payload: { step: from + i },
          })),
        }),
      });

    await append(1, ANCHOR_AT);
    // The checkpoint signs the head as of event 12 — which is what makes
    // everything below a statement about evidence rather than about a cursor.
    await api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionId}/checkpoints`, {
      method: "POST",
      body: JSON.stringify({ git_sha: mainSha, state: { note: "midpoint" } }),
    });
    await append(ANCHOR_AT + 1, TOTAL_EVENTS);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(gitRoot, { recursive: true, force: true });
  });

  // Restores the session to its pristine state after a test edits a row behind
  // the API's back. Every case below is destructive by design — that is the
  // only way to assert tamper-evidence — so each one puts the chain back.
  async function withTamper(mutate: () => Promise<void>, assertions: () => Promise<void>) {
    const before = await db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId))
      .orderBy(asc(sessionEvents.seq));
    try {
      await mutate();
      await assertions();
    } finally {
      await db.delete(sessionEvents).where(eq(sessionEvents.sessionId, sessionId));
      await db.insert(sessionEvents).values(before);
    }
  }

  it("reads in batches, and the batch boundary is not load-bearing", async () => {
    const answers = await Promise.all(
      [1, 2, 7, VERIFY_BATCH_SIZE].map((batchSize) => verifyChain(db, sessionId, { batchSize })),
    );
    for (const answer of answers) {
      expect(answer.ok).toBe(true);
      expect(answer.count).toBe(TOTAL_EVENTS);
      expect(answer.verifiedFromSeq).toBe(0);
      expect(answer.verifiedToSeq).toBe(TOTAL_EVENTS);
      expect(answer.prefix).toBe("recomputed");
    }
    // Same head, byte for byte, from four different read patterns.
    expect(new Set(answers.map((a) => a.head)).size).toBe(1);
  });

  it("anchors at the signed checkpoint, and says so rather than reporting a bare ok", async () => {
    const anchors = await verifiedAnchors(db, keys, sessionId);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.eventCount).toBe(ANCHOR_AT);

    const full = await verifySession(db, keys, sessionId, { coverage: "full" });
    const anchored = await verifySession(db, keys, sessionId, { coverage: "from-checkpoint" });

    expect(full.chain.ok).toBe(true);
    expect(anchored.chain.ok).toBe(true);
    // Identical heads: the anchored run recomputes the suffix from the signed
    // head, so it arrives at the same place having read eight rows instead of
    // twenty.
    expect(anchored.chain.head).toBe(full.chain.head);
    expect(anchored.chain.count).toBe(TOTAL_EVENTS);

    expect(full.chain.prefix).toBe("recomputed");
    expect(full.chain.verifiedFromSeq).toBe(0);
    // Full verification is not merely the slower option: it pins the
    // recomputation to the signed head on the way past.
    expect(full.chain.attestedHeadsChecked).toBe(1);
    expect(full.anchor).toBeNull();

    expect(anchored.chain.prefix).toBe("attested");
    expect(anchored.chain.verifiedFromSeq).toBe(ANCHOR_AT);
    expect(anchored.chain.verifiedToSeq).toBe(TOTAL_EVENTS);
    expect(anchored.anchor?.eventCount).toBe(ANCHOR_AT);
  });

  it("both coverages catch an edit after the anchor, at the same seq", async () => {
    await withTamper(
      async () => {
        await db
          .update(sessionEvents)
          .set({ tokensOut: 999_999 })
          .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.seq, 15)));
      },
      async () => {
        const full = await verifySession(db, keys, sessionId, { coverage: "full" });
        const anchored = await verifySession(db, keys, sessionId, { coverage: "from-checkpoint" });
        expect(full.chain.ok).toBe(false);
        expect(anchored.chain.ok).toBe(false);
        expect(full.chain.brokeAtSeq).toBe(15);
        expect(anchored.chain.brokeAtSeq).toBe(15);
        expect(anchored.chain.reason).toMatch(/does not match its recorded hash/);
      },
    );
  });

  // The boundary of the anchored guarantee, stated as a test rather than as a
  // caveat in a comment. An edit *before* the anchor that leaves the stored
  // hashes alone is caught by rehashing and not by the signature, because the
  // signature still describes a head the untouched hashes still produce.
  it("only full coverage catches a careless edit before the anchor", async () => {
    await withTamper(
      async () => {
        await db
          .update(sessionEvents)
          .set({ tokensOut: 999_999 })
          .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.seq, 5)));
      },
      async () => {
        const full = await verifySession(db, keys, sessionId, { coverage: "full" });
        expect(full.chain.ok).toBe(false);
        expect(full.chain.brokeAtSeq).toBe(5);

        const anchored = await verifySession(db, keys, sessionId, { coverage: "from-checkpoint" });
        expect(anchored.chain.ok).toBe(true);
        // And this is why the result may never be read as a bare `ok`: it says
        // it only recomputed from event 12, and that everything before it is
        // attested rather than rehashed.
        expect(anchored.chain.prefix).toBe("attested");
        expect(anchored.chain.verifiedFromSeq).toBe(ANCHOR_AT);
      },
    );
  });

  // The other direction, and the reason `full` checks signed heads at all: an
  // attacker who repairs every hash behind the edit produces a chain that
  // recomputes perfectly from its genesis. Only a signature over a head the
  // rewrite had to change catches it — and both coverages hold one.
  it("both coverages catch a rewrite that repaired its own hashes", async () => {
    await withTamper(
      async () => {
        const rows = await db
          .select()
          .from(sessionEvents)
          .where(eq(sessionEvents.sessionId, sessionId))
          .orderBy(asc(sessionEvents.seq));

        // Rewrite event 5 and re-chain everything after it, exactly as someone
        // with database access and the hashing code would.
        let prevHash = rows[3]!.hash;
        for (const row of rows.slice(4)) {
          const rewritten = { ...row, payload: row.seq === 5 ? { step: "rewritten" } : row.payload };
          const hash = eventHash(sessionId, prevHash, rewritten);
          await db
            .update(sessionEvents)
            .set({ payload: rewritten.payload, prevHash, hash })
            .where(eq(sessionEvents.id, row.id));
          prevHash = hash;
        }

        // Recomputing from the genesis now finds nothing wrong, which is the
        // whole point of the case.
        const naive = await verifyChain(db, sessionId);
        expect(naive.ok).toBe(true);
      },
      async () => {
        const full = await verifySession(db, keys, sessionId, { coverage: "full" });
        expect(full.chain.ok).toBe(false);
        expect(full.chain.brokeAtSeq).toBe(ANCHOR_AT);
        expect(full.chain.reason).toMatch(/rewritten after it was attested/);

        // The anchored coverage catches it at the boundary read instead: the
        // stored hash at event 12 is no longer the one that was signed.
        const anchored = await verifySession(db, keys, sessionId, { coverage: "from-checkpoint" });
        expect(anchored.chain.ok).toBe(false);
        expect(anchored.chain.brokeAtSeq).toBe(ANCHOR_AT);
        expect(anchored.chain.reason).toMatch(/was signed for it/);
      },
    );
  });

  // Deletion is the edit that leaves nothing behind to disagree with. A chain
  // truncated at the tail recomputes perfectly; the signed checkpoint naming an
  // event that is no longer there is the only evidence that anything is gone.
  it("does not catch a truncation past the anchor, which is the honest boundary", async () => {
    await withTamper(
      async () => {
        await db
          .delete(sessionEvents)
          .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.seq, TOTAL_EVENTS)));
      },
      async () => {
        // Nineteen events that chain perfectly. Rehashing has no complaint.
        const naive = await verifyChain(db, sessionId);
        expect(naive.ok).toBe(true);
        expect(naive.count).toBe(TOTAL_EVENTS - 1);

        // Neither coverage detects *this* one either, because the anchor is at
        // event 12 and the deletion is past it — there is no signature over
        // anything the deletion touched. Asserted rather than left unsaid: the
        // honest boundary is "a signed head beyond the truncation", not
        // "truncation".
        const full = await verifySession(db, keys, sessionId, { coverage: "full" });
        expect(full.chain.ok).toBe(true);
      },
    );
  });

  it("catches a chain truncated back past the anchor", async () => {
    await withTamper(
      async () => {
        await db
          .delete(sessionEvents)
          .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.seq, ANCHOR_AT)));
      },
      async () => {
        // A gap rather than a truncation is caught by rehashing alone.
        const full = await verifySession(db, keys, sessionId, { coverage: "full" });
        expect(full.chain.ok).toBe(false);

        // The anchored path finds it at the boundary read: the event the
        // signature names is not there.
        const anchored = await verifySession(db, keys, sessionId, { coverage: "from-checkpoint" });
        expect(anchored.chain.ok).toBe(false);
        expect(anchored.chain.brokeAtSeq).toBe(ANCHOR_AT);
        expect(anchored.chain.reason).toMatch(/attested but absent/);
      },
    );
  });

  // `emitterContiguity` moved from an array of every counter the session holds
  // into one aggregate. `contiguityOf` is still the statement of the math, and
  // it now has exactly one job: being the thing the SQL is checked against.
  it("computes emitter contiguity in SQL identically to the reference implementation", async () => {
    // Deliberately outside the run: this test breaks the emitter's numbering on
    // purpose, and a developer checkpointing their own work is a session with no
    // run anyway — which is the case that has the least test coverage.
    const counted = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "codex" }),
    });
    const countedId = counted.body.id as string;
    await api(`/api/adp/repos/${owner}/${repoName}/sessions/${countedId}/events`, {
      method: "POST",
      body: JSON.stringify({
        producer_id: "recorder@1.0.0",
        events: Array.from({ length: 6 }, (_, i) => ({
          kind: "message",
          type: "assistant",
          payload: { step: i + 1 },
          producer_seq: i + 1,
          client_event_id: `counted-${i + 1}`,
        })),
      }),
    });

    const compare = async () => {
      const stored = await db
        .select({ producerSeq: sessionEvents.producerSeq })
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, countedId))
        .orderBy(asc(sessionEvents.producerSeq));
      const reference = contiguityOf(stored.map((r) => r.producerSeq!).filter((n) => n !== null));
      expect(await emitterContiguity(db, countedId)).toEqual(reference);
      return reference;
    };

    expect(await compare()).toEqual({ tracked: true, complete: true, maxSeq: 6, firstGap: null });

    // A gap the ingest path refuses to create, made the only way it can happen
    // in production: a row disappearing after the fact.
    await db
      .delete(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, countedId), eq(sessionEvents.producerSeq, 3)));
    expect(await compare()).toEqual({ tracked: true, complete: false, maxSeq: 6, firstGap: 3 });

    // And the untracked case, which is a different statement from incomplete.
    expect(await emitterContiguity(db, sessionId)).toEqual({
      tracked: false,
      complete: true,
      maxSeq: null,
      firstGap: null,
    });
  });

  // The session-scoped endpoint, which exists for the two cases the run-level
  // one cannot cover: a session with no run, and a session too long to verify
  // in one request.
  describe("the session endpoint", () => {
    const verify = (query = "") =>
      api(`/api/adp/repos/${owner}/${repoName}/sessions/${sessionId}/verify${query}`);

    it("defaults to full coverage and says so", async () => {
      const res = await verify();
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.coverage).toBe("full");
      expect(res.body.prefix).toBe("recomputed");
      expect(res.body.verified_from_seq).toBe(0);
      expect(res.body.verified_to_seq).toBe(TOTAL_EVENTS);
      expect(res.body.attested_heads_checked).toBe(1);
      expect(res.body.anchor).toBeNull();
    });

    it("anchors at the newest signed checkpoint on request", async () => {
      const res = await verify("?from=checkpoint");
      expect(res.body.ok).toBe(true);
      expect(res.body.coverage).toBe("from-checkpoint");
      expect(res.body.prefix).toBe("attested");
      expect(res.body.verified_from_seq).toBe(ANCHOR_AT);
      expect((res.body.anchor as Record<string, unknown>).event_count).toBe(ANCHOR_AT);
    });

    // The point of a window: walk a session in passes and every event has been
    // recomputed, without any one request holding the session.
    it("walks an explicit window, and the passes cover the chain between them", async () => {
      const first = await verify("?to_seq=8");
      expect(first.body.ok).toBe(true);
      expect(first.body.coverage).toBe("range");
      // A window from the genesis has no prefix to assume anything about.
      expect(first.body.prefix).toBe("recomputed");
      expect(first.body.verified_from_seq).toBe(0);
      expect(first.body.verified_to_seq).toBe(8);

      const second = await verify("?from_seq=8&to_seq=16");
      expect(second.body.ok).toBe(true);
      expect(second.body.prefix).toBe("assumed");
      expect(second.body.verified_from_seq).toBe(8);
      expect(second.body.verified_to_seq).toBe(16);
      // A signed head inside the window is still checked — narrowing what you
      // recompute is not a reason to stop comparing it to what was signed.
      expect(second.body.attested_heads_checked).toBe(1);

      const third = await verify(`?from_seq=16&to_seq=${TOTAL_EVENTS}`);
      expect(third.body.ok).toBe(true);
      expect(third.body.verified_to_seq).toBe(TOTAL_EVENTS);
    });

    it("catches an edit inside the window and reports it clear of one that ends first", async () => {
      await withTamper(
        async () => {
          await db
            .update(sessionEvents)
            .set({ tokensOut: 999_999 })
            .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.seq, 14)));
        },
        async () => {
          const covering = await verify("?from_seq=8&to_seq=16");
          expect(covering.body.ok).toBe(false);
          expect(covering.body.broke_at_seq).toBe(14);

          // And a window that stops before the edit reports honestly on what it
          // looked at rather than on the session.
          const earlier = await verify("?to_seq=8");
          expect(earlier.body.ok).toBe(true);
          expect(earlier.body.verified_to_seq).toBe(8);
        },
      );
    });

    it("refuses an anchor combined with a window, rather than moving the anchor", async () => {
      const res = await verify("?from=checkpoint&from_seq=4");
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toMatch(/cannot be combined/);
    });

    it("refuses a window that runs backwards", async () => {
      const res = await verify("?from_seq=9&to_seq=4");
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toMatch(/greater than from_seq/);
    });

    it("reports on a session that belongs to no run at all", async () => {
      const solo = await api(`/api/adp/repos/${owner}/${repoName}/sessions`, {
        method: "POST",
        body: JSON.stringify({ harness: "gemini-cli" }),
      });
      const soloId = solo.body.id as string;
      await api(`/api/adp/repos/${owner}/${repoName}/sessions/${soloId}/events`, {
        method: "POST",
        body: JSON.stringify({ events: [{ kind: "message", type: "user", payload: { text: "hi" } }] }),
      });
      const res = await api(`/api/adp/repos/${owner}/${repoName}/sessions/${soloId}/verify`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.event_count).toBe(1);
      // Never checkpointed, so nothing pins the recomputation. A fact about the
      // record, reported rather than rounded up to a green tick.
      expect(res.body.attested_heads_checked).toBe(0);
    });

    it("is a 404 for a session id belonging to another repo, not a probe", async () => {
      await api(`/api/v3/repos/${owner}`, { method: "POST", body: JSON.stringify({ name: "other" }) });
      const res = await api(`/api/adp/repos/${owner}/other/sessions/${sessionId}/verify`);
      expect(res.status).toBe(404);
    });
  });

  it("the run endpoint reports its coverage, and full stays the default", async () => {
    const full = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/verify`);
    expect(full.status).toBe(200);
    expect(full.body.ok).toBe(true);
    expect(full.body.coverage).toBe("full");
    const sessions = full.body.sessions as Record<string, unknown>[];
    expect(sessions).toHaveLength(1);
    const session = sessions.find((s) => s.session_id === sessionId)!;
    expect(session.prefix).toBe("recomputed");
    expect(session.verified_from_seq).toBe(0);
    expect(session.verified_to_seq).toBe(TOTAL_EVENTS);
    expect(session.attested_heads_checked).toBe(1);
    expect(session.anchor).toBeNull();

    const anchored = await api(`/api/adp/repos/${owner}/${repoName}/runs/${runId}/verify?from=checkpoint`);
    expect(anchored.body.ok).toBe(true);
    expect(anchored.body.coverage).toBe("from-checkpoint");
    const anchoredSession = (anchored.body.sessions as Record<string, unknown>[]).find(
      (s) => s.session_id === sessionId,
    )!;
    expect(anchoredSession.prefix).toBe("attested");
    expect(anchoredSession.verified_from_seq).toBe(ANCHOR_AT);
    expect((anchoredSession.anchor as Record<string, unknown>).event_count).toBe(ANCHOR_AT);

    // The attestation check survives anchoring: the digest is computed from
    // each session's length and head, and an anchored verification still
    // establishes both.
    expect(anchored.body.recomputed_trajectory_digest).toBe(full.body.recomputed_trajectory_digest);
  });
});
