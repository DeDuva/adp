import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { Signer } from "./signing.js";
import { evals, gateResults, identities, runs } from "../db/schema.js";
import { canonicalJson } from "./canonical.js";
import { recordOperation } from "./operations.js";
import { signStatement, type InTotoStatement } from "./dsse.js";
import { runChains, trajectoryDigest } from "./runs.js";

export type EvalRow = typeof evals.$inferSelect;

// An eval plus who reported it. `separatelyAuthorized` is the whole reason the
// reporter is surfaced at all: a run that scores its own work is a self-report,
// and a score is only independent evidence if the identity that wrote it is not
// the identity that did the work. `gate_results.reporterId` already recorded
// this; without projecting it here, "separately authorized" stays an assertion
// nobody downstream can check.
export interface EvalWithReporter extends EvalRow {
  reporterId: string;
  reporterPrincipal: string;
  separatelyAuthorized: boolean;
}

export const EVAL_PREDICATE_TYPE = "https://adp.dev/attestations/eval/v1";

export interface EvalError {
  ok: false;
  status: 404 | 409 | 422;
  message: string;
}

// What makes "deterministic" a claim rather than an adjective: the digest of the
// eval definition that produced the score. Two results for the same commit with
// different spec digests were not produced by the same eval, and comparing them
// as if they were is how an eval-gated queue starts landing the wrong winner.
//
// The caller may supply its own digest — an eval harness that already
// content-addresses its suites should — and otherwise it is derived from the
// spec object here.
export function specDigest(spec: unknown): string {
  return createHash("sha256").update(canonicalJson(spec ?? null), "utf8").digest("hex");
}

export interface RecordEvalInput {
  name: string;
  passed: boolean;
  score?: number;
  summary?: string;
  spec?: unknown;
  specDigest?: string;
  // Defaults to `eval:<name>`. Overridable because a candidate set's
  // `best_score` policy ranks on a gate literally named `score`
  // (core/candidate-sets.ts), so an orchestrator running a fan-out reports its
  // eval under that name and the existing selection path consumes it unchanged —
  // no second evidence path, no special case in the resolver.
  gateName?: string;
  gitSha?: string;
  metrics?: Record<string, unknown>;
}

export interface RecordEvalResult {
  ok: true;
  eval: EvalWithReporter;
  gateResult: typeof gateResults.$inferSelect;
}

// Records a deterministic eval against a run, as gate evidence.
//
// The eval *is* a gate result — signed with the same machinery, stored in the
// same table, resolved by the same land policy and the same `gh pr checks`
// projection. What the `evals` row adds is the run binding: this score belongs
// to that assignment, scored against that trajectory. Brief v5 §the-thesis calls
// binding context to verification evidence "the half nobody has built"; this
// function is that binding, and `trajectoryDigest` in the signed predicate is
// what makes it checkable rather than asserted.
export async function recordEval(
  db: Db,
  signer: Signer,
  publicUrl: string,
  repo: { id: string; owner: string; name: string },
  runId: string,
  input: RecordEvalInput,
  actor: { identityId: string; principal: string },
): Promise<RecordEvalResult | EvalError> {
  const [run] = await db.select().from(runs).where(and(eq(runs.id, runId), eq(runs.repoId, repo.id)));
  if (!run) return { ok: false, status: 404, message: "run not found" };

  // Default to the commit the run closed against. An eval that names no commit
  // and belongs to a run that never closed is scoring nothing in particular.
  const gitSha = input.gitSha ?? run.finalGitSha;
  if (!gitSha) {
    return {
      ok: false,
      status: 422,
      message: "run has no final_git_sha — close the run first, or pass git_sha explicitly",
    };
  }
  if (!/^[0-9a-f]{40}$/.test(gitSha)) {
    return { ok: false, status: 422, message: `git_sha '${gitSha}' is not a 40-character sha` };
  }

  const digest = input.specDigest ?? specDigest(input.spec ?? { name: input.name });

  // Prefer the digest frozen into the run attestation at close time. Recomputing
  // it for an open run is still useful (a mid-flight eval is a real thing), but
  // for a closed run the signed value is the one anyone else will check against.
  const trajDigest = run.trajectoryDigest ?? trajectoryDigest(await runChains(db, runId));

  const gateName = input.gateName ?? `eval:${input.name}`;
  const status = input.passed ? ("success" as const) : ("failure" as const);
  const summary =
    input.summary ?? `${input.name}: ${input.passed ? "passed" : "failed"}${input.score !== undefined ? ` (score ${input.score})` : ""}`;

  const statement: InTotoStatement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `git+${publicUrl}/${repo.owner}/${repo.name}`, digest: { sha1: gitSha } }],
    predicateType: EVAL_PREDICATE_TYPE,
    predicate: {
      eval: input.name,
      gate: gateName,
      status,
      summary,
      passed: input.passed,
      // `score` under the same key the gate-result predicate uses, so
      // candidate-sets' scorer reads an eval envelope without knowing it is one.
      ...(input.score !== undefined ? { score: input.score } : {}),
      specDigest: digest,
      runId: run.id,
      intentId: run.intentId,
      orchestrator: run.orchestrator,
      trajectoryDigest: trajDigest,
      reporter: actor.principal,
      ...(input.metrics ? { metrics: input.metrics } : {}),
    },
  };
  const envelope = signStatement(signer, statement);

  const recorded = await db.transaction(async (tx) => {
    const [gateRow] = await tx
      .insert(gateResults)
      .values({
        repoId: repo.id,
        gitSha,
        name: gateName,
        status,
        summary,
        reporterId: actor.identityId,
        envelope,
      })
      .returning();

    const [evalRow] = await tx
      .insert(evals)
      .values({
        repoId: repo.id,
        runId: run.id,
        name: input.name,
        gitSha,
        specDigest: digest,
        score: input.score ?? null,
        passed: input.passed,
        gateResultId: gateRow!.id,
        trajectoryDigest: trajDigest,
      })
      .returning();

    await recordOperation(tx, {
      repoId: repo.id,
      actorId: actor.identityId,
      verb: "eval.record",
      target: `${repo.owner}/${repo.name}@run:${run.id}#${input.name}`,
      after: {
        evalId: evalRow!.id,
        gateResultId: gateRow!.id,
        gate: gateName,
        gitSha,
        passed: input.passed,
        score: input.score ?? null,
        specDigest: digest,
        trajectoryDigest: trajDigest,
      },
    });

    return { evalRow: evalRow!, gateRow: gateRow! };
  });

  return {
    ok: true,
    eval: {
      ...recorded.evalRow,
      reporterId: actor.identityId,
      reporterPrincipal: actor.principal,
      separatelyAuthorized: actor.identityId !== run.actorId,
    },
    gateResult: recorded.gateRow,
  };
}

export async function listEvals(db: Db, runId: string): Promise<EvalWithReporter[]> {
  const rows = await db
    .select({ evalRow: evals, reporterId: gateResults.reporterId, principal: identities.principal, runActorId: runs.actorId })
    .from(evals)
    .innerJoin(gateResults, eq(evals.gateResultId, gateResults.id))
    .innerJoin(identities, eq(gateResults.reporterId, identities.id))
    .innerJoin(runs, eq(evals.runId, runs.id))
    .where(eq(evals.runId, runId))
    .orderBy(desc(evals.createdAt));

  return rows.map((r) => ({
    ...r.evalRow,
    reporterId: r.reporterId,
    reporterPrincipal: r.principal,
    separatelyAuthorized: r.reporterId !== r.runActorId,
  }));
}

export function serializeEval(row: EvalWithReporter) {
  return {
    id: row.id,
    run_id: row.runId,
    name: row.name,
    git_sha: row.gitSha,
    spec_digest: row.specDigest,
    score: row.score,
    passed: row.passed,
    gate_result_id: row.gateResultId,
    trajectory_digest: row.trajectoryDigest,
    reporter_principal: row.reporterPrincipal,
    // True when the identity that reported the score is not the identity that
    // opened the run — i.e. the score is not a self-report.
    separately_authorized: row.separatelyAuthorized,
    created_at: row.createdAt.toISOString(),
  };
}
