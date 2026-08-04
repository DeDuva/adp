import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "./git-backend.js";
import type { Signer } from "./signing.js";
import { evals, gateResults, intents, runs, sessionEvents, sessions } from "../db/schema.js";
import { canonicalJson } from "./canonical.js";
import { recordOperation } from "./operations.js";
import { signStatement, type InTotoStatement } from "./dsse.js";
import { chainGenesis, serializeEvent, type SessionEventRow } from "./trajectory.js";

export type RunRow = typeof runs.$inferSelect;

export const RUN_PREDICATE_TYPE = "https://adp.dev/attestations/run/v1";

export interface RunError {
  ok: false;
  status: 404 | 409 | 422;
  message: string;
}

export interface SessionChain {
  sessionId: string;
  harness: string;
  count: number;
  head: string;
}

// One value naming the whole run's trajectory: every session's chain head,
// ordered by session id so that the digest depends on the trajectory and not on
// the order the query happened to return rows in.
export function trajectoryDigest(chains: SessionChain[]): string {
  const ordered = [...chains].sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  return createHash("sha256")
    .update(
      canonicalJson({
        v: 1,
        sessions: ordered.map((c) => ({ id: c.sessionId, harness: c.harness, count: c.count, head: c.head })),
      }),
      "utf8",
    )
    .digest("hex");
}

// The heads of every session in a run, in one query rather than one per session
// — a 50-way fan-out closes 50 sessions and this is on the close path.
export async function runChains(db: Db, runId: string): Promise<SessionChain[]> {
  const rows = await db
    .select({
      sessionId: sessions.id,
      harness: sessions.harness,
      count: sql<number>`coalesce(max(${sessionEvents.seq}), 0)`,
      head: sql<string | null>`(array_agg(${sessionEvents.hash} order by ${sessionEvents.seq} desc))[1]`,
    })
    .from(sessions)
    .leftJoin(sessionEvents, eq(sessionEvents.sessionId, sessions.id))
    .where(eq(sessions.runId, runId))
    .groupBy(sessions.id, sessions.harness);

  return rows.map((r) => ({
    sessionId: r.sessionId,
    harness: r.harness,
    count: Number(r.count),
    head: r.head ?? chainGenesis(r.sessionId),
  }));
}

export function runStatement(
  publicUrl: string,
  repo: { owner: string; name: string },
  run: RunRow,
  finalGitSha: string,
  chains: SessionChain[],
  digest: string,
): InTotoStatement {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `git+${publicUrl}/${repo.owner}/${repo.name}`, digest: { sha1: finalGitSha } }],
    predicateType: RUN_PREDICATE_TYPE,
    predicate: {
      runId: run.id,
      intentId: run.intentId,
      orchestrator: run.orchestrator,
      externalRef: run.externalRef,
      trajectoryDigest: digest,
      sessions: [...chains]
        .sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1))
        .map((c) => ({ id: c.sessionId, harness: c.harness, eventCount: c.count, chainHead: c.head })),
      openedAt: run.createdAt.toISOString(),
    },
  };
}

export async function openRun(
  db: Db,
  repo: { id: string; owner: string; name: string },
  input: { intentId: string; orchestrator: string; externalRef?: string | null },
  actorId: string,
): Promise<{ ok: true; run: RunRow; created: boolean } | RunError> {
  const [intent] = await db
    .select()
    .from(intents)
    .where(and(eq(intents.id, input.intentId), eq(intents.repoId, repo.id)));
  if (!intent) return { ok: false, status: 422, message: `intent ${input.intentId} not found in this repository` };

  // Re-opening an assignment after an orchestrator crash must resolve to the
  // run that already exists, or the trajectory forks into two halves that each
  // look complete. Same reasoning as the candidate-set resolution idempotency
  // fix (PR #55): the interesting case is always the re-entry.
  if (input.externalRef) {
    const [existing] = await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.repoId, repo.id),
          eq(runs.orchestrator, input.orchestrator),
          eq(runs.externalRef, input.externalRef),
        ),
      );
    if (existing) {
      if (existing.status !== "open") {
        return {
          ok: false,
          status: 409,
          message: `run for ${input.orchestrator} ref '${input.externalRef}' is already ${existing.status}`,
        };
      }
      return { ok: true, run: existing, created: false };
    }
  }

  const run = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(runs)
      .values({
        repoId: repo.id,
        intentId: input.intentId,
        orchestrator: input.orchestrator,
        externalRef: input.externalRef ?? null,
        actorId,
      })
      .returning();

    await recordOperation(tx, {
      repoId: repo.id,
      actorId,
      verb: "run.open",
      target: `${repo.owner}/${repo.name}@run:${row!.id}`,
      after: {
        id: row!.id,
        intentId: input.intentId,
        orchestrator: input.orchestrator,
        externalRef: input.externalRef ?? null,
      },
    });

    return row!;
  });

  return { ok: true, run, created: true };
}

export interface CloseRunResult {
  ok: true;
  run: RunRow;
  chains: SessionChain[];
  closedSessions: string[];
  alreadyClosed: boolean;
}

// Closes a run against the commit it produced, and signs the binding.
//
// Any still-open session is closed here, and that is load-bearing rather than
// tidy: the attestation names each session's chain head, so a session that could
// still append after signing would leave an attestation that no longer describes
// the trajectory — verification failing for an honest reason is worse than not
// verifying at all.
export async function closeRun(
  db: Db,
  gitBackend: GitBackend,
  signer: Signer,
  publicUrl: string,
  repo: { id: string; owner: string; name: string },
  runId: string,
  input: { finalGitSha: string },
  actorId: string,
): Promise<CloseRunResult | RunError> {
  const [run] = await db.select().from(runs).where(and(eq(runs.id, runId), eq(runs.repoId, repo.id)));
  if (!run) return { ok: false, status: 404, message: "run not found" };

  if (run.status !== "open") {
    if (run.status === "closed" && run.finalGitSha === input.finalGitSha) {
      return { ok: true, run, chains: await runChains(db, runId), closedSessions: [], alreadyClosed: true };
    }
    return {
      ok: false,
      status: 409,
      message:
        run.status === "closed"
          ? `run already closed against ${run.finalGitSha}, cannot re-close against ${input.finalGitSha}`
          : `run is ${run.status}`,
    };
  }

  // A run closing against a commit this repo doesn't have is a claim nobody can
  // check later — the same reason a checkpoint resolves its sha at write time.
  if (!(await gitBackend.statPath(repo.owner, repo.name, input.finalGitSha, ""))) {
    return { ok: false, status: 422, message: `commit '${input.finalGitSha}' could not be resolved in this repository` };
  }

  const closed = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from runs where id = ${runId} for update`);

    const stillOpen = await tx
      .update(sessions)
      .set({ status: "closed", updatedAt: new Date() })
      .where(and(eq(sessions.runId, runId), sql`${sessions.status} <> 'closed'`))
      .returning({ id: sessions.id });

    const chains = await runChains(tx as unknown as Db, runId);
    const digest = trajectoryDigest(chains);
    const envelope = signStatement(signer, runStatement(publicUrl, repo, run, input.finalGitSha, chains, digest));

    const [row] = await tx
      .update(runs)
      .set({
        status: "closed",
        finalGitSha: input.finalGitSha,
        trajectoryDigest: digest,
        envelope,
        closedAt: new Date(),
      })
      .where(eq(runs.id, runId))
      .returning();

    await recordOperation(tx, {
      repoId: repo.id,
      actorId,
      verb: "run.close",
      target: `${repo.owner}/${repo.name}@run:${runId}`,
      before: { status: "open" },
      after: {
        status: "closed",
        finalGitSha: input.finalGitSha,
        trajectoryDigest: digest,
        sessions: chains.map((c) => ({ id: c.sessionId, eventCount: c.count, chainHead: c.head })),
        closedSessions: stillOpen.map((s) => s.id),
      },
    });

    return { row: row!, chains, closedSessions: stillOpen.map((s) => s.id) };
  });

  return {
    ok: true,
    run: closed.row,
    chains: closed.chains,
    closedSessions: closed.closedSessions,
    alreadyClosed: false,
  };
}

export async function abandonRun(
  db: Db,
  repo: { id: string; owner: string; name: string },
  runId: string,
  reason: string,
  actorId: string,
): Promise<{ ok: true; run: RunRow } | RunError> {
  const [run] = await db.select().from(runs).where(and(eq(runs.id, runId), eq(runs.repoId, repo.id)));
  if (!run) return { ok: false, status: 404, message: "run not found" };
  if (run.status === "abandoned") return { ok: true, run };
  if (run.status === "closed") return { ok: false, status: 409, message: "cannot abandon a closed run" };

  const abandoned = await db.transaction(async (tx) => {
    await tx
      .update(sessions)
      .set({ status: "closed", updatedAt: new Date() })
      .where(and(eq(sessions.runId, runId), sql`${sessions.status} <> 'closed'`));

    const [row] = await tx
      .update(runs)
      .set({ status: "abandoned", closedAt: new Date() })
      .where(eq(runs.id, runId))
      .returning();

    await recordOperation(tx, {
      repoId: repo.id,
      actorId,
      verb: "run.abandon",
      target: `${repo.owner}/${repo.name}@run:${runId}`,
      before: { status: run.status },
      after: { status: "abandoned", reason },
    });

    return row!;
  });

  return { ok: true, run: abandoned };
}

export interface KindStat {
  kind: string;
  count: number;
  tokensIn: number;
  tokensOut: number;
  costMicroUsd: number;
  durationMs: number;
  failures: number;
}

export interface RunStats {
  runId: string;
  sessions: number;
  events: number;
  byKind: KindStat[];
  tokensIn: number;
  tokensOut: number;
  costMicroUsd: number;
  durationMs: number;
  tools: { name: string; count: number; failures: number }[];
  models: { model: string; calls: number; tokensIn: number; tokensOut: number; costMicroUsd: number }[];
  handoffs: { from: string; to: string; count: number }[];
  commits: string[];
}

// The shape eval-based optimization actually reads: what a run cost, what it
// spent it on, and where it failed — computed in SQL over the typed columns
// rather than by pulling a million payloads into Node to count them.
export async function runStats(db: Db, runId: string): Promise<RunStats> {
  const sessionRows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.runId, runId));
  const sessionIds = sessionRows.map((s) => s.id);
  if (sessionIds.length === 0) {
    return {
      runId,
      sessions: 0,
      events: 0,
      byKind: [],
      tokensIn: 0,
      tokensOut: 0,
      costMicroUsd: 0,
      durationMs: 0,
      tools: [],
      models: [],
      handoffs: [],
      commits: [],
    };
  }
  const scope = inArray(sessionEvents.sessionId, sessionIds);
  const num = (v: unknown) => Number(v ?? 0);

  const byKind = await db
    .select({
      kind: sessionEvents.kind,
      count: sql<number>`count(*)`,
      tokensIn: sql<number>`coalesce(sum(${sessionEvents.tokensIn}), 0)`,
      tokensOut: sql<number>`coalesce(sum(${sessionEvents.tokensOut}), 0)`,
      costMicroUsd: sql<number>`coalesce(sum(${sessionEvents.costMicroUsd}), 0)`,
      durationMs: sql<number>`coalesce(sum(${sessionEvents.durationMs}), 0)`,
      failures: sql<number>`count(*) filter (where ${sessionEvents.status} in ('failure', 'error'))`,
    })
    .from(sessionEvents)
    .where(scope)
    .groupBy(sessionEvents.kind);

  const tools = await db
    .select({
      name: sessionEvents.type,
      count: sql<number>`count(*)`,
      failures: sql<number>`count(*) filter (where ${sessionEvents.status} in ('failure', 'error', 'rejected'))`,
    })
    .from(sessionEvents)
    .where(and(scope, eq(sessionEvents.kind, "tool_call")))
    .groupBy(sessionEvents.type)
    .orderBy(desc(sql`count(*)`));

  const models = await db
    .select({
      model: sessionEvents.model,
      calls: sql<number>`count(*)`,
      tokensIn: sql<number>`coalesce(sum(${sessionEvents.tokensIn}), 0)`,
      tokensOut: sql<number>`coalesce(sum(${sessionEvents.tokensOut}), 0)`,
      costMicroUsd: sql<number>`coalesce(sum(${sessionEvents.costMicroUsd}), 0)`,
    })
    .from(sessionEvents)
    .where(and(scope, sql`${sessionEvents.model} is not null`))
    .groupBy(sessionEvents.model)
    .orderBy(desc(sql`count(*)`));

  const handoffs = await db
    .select({
      from: sessionEvents.sessionId,
      to: sessionEvents.relatedSessionId,
      count: sql<number>`count(*)`,
    })
    .from(sessionEvents)
    .where(and(scope, eq(sessionEvents.kind, "handoff"), sql`${sessionEvents.relatedSessionId} is not null`))
    .groupBy(sessionEvents.sessionId, sessionEvents.relatedSessionId);

  const commitRows = await db
    .selectDistinct({ gitSha: sessionEvents.gitSha })
    .from(sessionEvents)
    .where(and(scope, eq(sessionEvents.kind, "commit"), sql`${sessionEvents.gitSha} is not null`));

  const stats: RunStats = {
    runId,
    sessions: sessionIds.length,
    events: byKind.reduce((sum, k) => sum + num(k.count), 0),
    byKind: byKind.map((k) => ({
      kind: k.kind,
      count: num(k.count),
      tokensIn: num(k.tokensIn),
      tokensOut: num(k.tokensOut),
      costMicroUsd: num(k.costMicroUsd),
      durationMs: num(k.durationMs),
      failures: num(k.failures),
    })),
    tokensIn: 0,
    tokensOut: 0,
    costMicroUsd: 0,
    durationMs: 0,
    tools: tools.map((t) => ({ name: t.name, count: num(t.count), failures: num(t.failures) })),
    models: models.map((m) => ({
      model: m.model ?? "",
      calls: num(m.calls),
      tokensIn: num(m.tokensIn),
      tokensOut: num(m.tokensOut),
      costMicroUsd: num(m.costMicroUsd),
    })),
    handoffs: handoffs.map((h) => ({ from: h.from, to: h.to!, count: num(h.count) })),
    commits: commitRows.map((c) => c.gitSha!),
  };
  for (const k of stats.byKind) {
    stats.tokensIn += k.tokensIn;
    stats.tokensOut += k.tokensOut;
    stats.costMicroUsd += k.costMicroUsd;
    stats.durationMs += k.durationMs;
  }
  return stats;
}

// One run's trajectory, merged across its sessions in the order things actually
// happened. Ordered by `occurred_at` with `(session_id, seq)` as the tiebreak,
// so a merged view is stable even when two agents report the same millisecond.
export async function runTrajectory(
  db: Db,
  runId: string,
  options: { kinds?: string[]; limit?: number; offset?: number } = {},
): Promise<{ events: SessionEventRow[]; total: number }> {
  const sessionRows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.runId, runId));
  const sessionIds = sessionRows.map((s) => s.id);
  if (sessionIds.length === 0) return { events: [], total: 0 };

  const filters = [inArray(sessionEvents.sessionId, sessionIds)];
  if (options.kinds && options.kinds.length > 0) filters.push(inArray(sessionEvents.kind, options.kinds as never[]));

  const [totalRow] = await db
    .select({ total: sql<number>`count(*)` })
    .from(sessionEvents)
    .where(and(...filters));

  const events = await db
    .select()
    .from(sessionEvents)
    .where(and(...filters))
    .orderBy(asc(sessionEvents.occurredAt), asc(sessionEvents.sessionId), asc(sessionEvents.seq))
    .limit(Math.min(options.limit ?? 200, 2000))
    .offset(options.offset ?? 0);

  return { events, total: Number(totalRow?.total ?? 0) };
}

export interface RunComparison {
  runId: string;
  externalRef: string | null;
  orchestrator: string;
  status: string;
  finalGitSha: string | null;
  trajectoryDigest: string | null;
  eval: { name: string; score: number | null; passed: boolean; specDigest: string; gateStatus: string } | null;
  events: number;
  tokensIn: number;
  tokensOut: number;
  costMicroUsd: number;
  durationMs: number;
  toolCalls: number;
  toolFailures: number;
  createdAt: string;
  closedAt: string | null;
}

// N runs against one intent, scored — the table eval-based optimization is read
// off. Every row pairs an attested outcome with what the trajectory cost to
// produce it, which is the comparison "which way of working is better" needs and
// which no amount of per-run inspection gives you.
//
// Ranked by score descending, unscored runs last: an unscored run is unmeasured,
// not bad, and sorting it as if it scored zero would quietly invent evidence.
export async function compareRuns(
  db: Db,
  repoId: string,
  filter: { intentId?: string; evalName?: string; limit?: number },
): Promise<RunComparison[]> {
  const runFilters = [eq(runs.repoId, repoId)];
  if (filter.intentId) runFilters.push(eq(runs.intentId, filter.intentId));

  const runRows = await db
    .select()
    .from(runs)
    .where(and(...runFilters))
    .orderBy(desc(runs.createdAt))
    .limit(Math.min(filter.limit ?? 50, 200));
  if (runRows.length === 0) return [];

  const runIds = runRows.map((r) => r.id);

  const sessionRows = await db
    .select({ id: sessions.id, runId: sessions.runId })
    .from(sessions)
    .where(inArray(sessions.runId, runIds));
  const sessionToRun = new Map(sessionRows.map((s) => [s.id, s.runId!]));

  const aggregates =
    sessionRows.length === 0
      ? []
      : await db
          .select({
            sessionId: sessionEvents.sessionId,
            events: sql<number>`count(*)`,
            tokensIn: sql<number>`coalesce(sum(${sessionEvents.tokensIn}), 0)`,
            tokensOut: sql<number>`coalesce(sum(${sessionEvents.tokensOut}), 0)`,
            costMicroUsd: sql<number>`coalesce(sum(${sessionEvents.costMicroUsd}), 0)`,
            durationMs: sql<number>`coalesce(sum(${sessionEvents.durationMs}), 0)`,
            toolCalls: sql<number>`count(*) filter (where ${sessionEvents.kind} = 'tool_call')`,
            toolFailures: sql<number>`count(*) filter (where ${sessionEvents.kind} = 'tool_call' and ${sessionEvents.status} in ('failure', 'error', 'rejected'))`,
          })
          .from(sessionEvents)
          .where(inArray(sessionEvents.sessionId, sessionRows.map((s) => s.id)))
          .groupBy(sessionEvents.sessionId);

  const evalFilters = [inArray(evals.runId, runIds)];
  if (filter.evalName) evalFilters.push(eq(evals.name, filter.evalName));
  const evalRows = await db
    .select({
      runId: evals.runId,
      name: evals.name,
      score: evals.score,
      passed: evals.passed,
      specDigest: evals.specDigest,
      createdAt: evals.createdAt,
      gateStatus: gateResults.status,
    })
    .from(evals)
    .innerJoin(gateResults, eq(gateResults.id, evals.gateResultId))
    .where(and(...evalFilters))
    .orderBy(asc(evals.createdAt));
  // Latest eval per run wins, matching how gate results resolve elsewhere
  // (core/gate-results-lookup.ts): a rerun supersedes, history is kept.
  const latestEval = new Map<string, (typeof evalRows)[number]>();
  for (const row of evalRows) latestEval.set(row.runId, row);

  const totals = new Map<string, Omit<RunComparison, "runId" | "externalRef" | "orchestrator" | "status" | "finalGitSha" | "trajectoryDigest" | "eval" | "createdAt" | "closedAt">>();
  for (const id of runIds) {
    totals.set(id, { events: 0, tokensIn: 0, tokensOut: 0, costMicroUsd: 0, durationMs: 0, toolCalls: 0, toolFailures: 0 });
  }
  for (const agg of aggregates) {
    const runId = sessionToRun.get(agg.sessionId);
    if (!runId) continue;
    const t = totals.get(runId)!;
    t.events += Number(agg.events);
    t.tokensIn += Number(agg.tokensIn);
    t.tokensOut += Number(agg.tokensOut);
    t.costMicroUsd += Number(agg.costMicroUsd);
    t.durationMs += Number(agg.durationMs);
    t.toolCalls += Number(agg.toolCalls);
    t.toolFailures += Number(agg.toolFailures);
  }

  const comparisons: RunComparison[] = runRows.map((run) => {
    const e = latestEval.get(run.id);
    return {
      runId: run.id,
      externalRef: run.externalRef,
      orchestrator: run.orchestrator,
      status: run.status,
      finalGitSha: run.finalGitSha,
      trajectoryDigest: run.trajectoryDigest,
      eval: e
        ? { name: e.name, score: e.score, passed: e.passed, specDigest: e.specDigest, gateStatus: e.gateStatus }
        : null,
      ...totals.get(run.id)!,
      createdAt: run.createdAt.toISOString(),
      closedAt: run.closedAt?.toISOString() ?? null,
    };
  });

  return comparisons.sort((a, b) => {
    const as = a.eval?.score ?? null;
    const bs = b.eval?.score ?? null;
    if (as === null && bs === null) return b.createdAt.localeCompare(a.createdAt);
    if (as === null) return 1;
    if (bs === null) return -1;
    return bs - as;
  });
}

export function serializeRun(row: RunRow) {
  return {
    id: row.id,
    intent_id: row.intentId,
    orchestrator: row.orchestrator,
    external_ref: row.externalRef,
    status: row.status,
    final_git_sha: row.finalGitSha,
    trajectory_digest: row.trajectoryDigest,
    // The envelope is the evidence, not a projection of it — same rule as gate
    // results and checkpoints: a caller verifies without trusting our summary.
    envelope: row.envelope,
    created_at: row.createdAt.toISOString(),
    closed_at: row.closedAt?.toISOString() ?? null,
  };
}

export { serializeEvent };
