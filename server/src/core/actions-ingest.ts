import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { Signer } from "./signing.js";
import { gateResults, identities } from "../db/schema.js";
import { signStatement, type InTotoStatement } from "./dsse.js";
import { recordOperation } from "./operations.js";

// Ingest for a mirrored repo's upstream CI results.
//
// This is the half of "Actions in mirror mode" that carries the actual claim
// (docs/pragmatic_mvp.md §2.4 and the M2 milestone): the repo stays on GitHub,
// GitHub's runners execute the workflows unchanged, and the *results* land here
// as ordinary signed gate evidence. Nothing is reimplemented — marketplace
// actions, matrix builds, self-hosted runners and OIDC all keep working because
// none of them were touched.
//
// It is also the single writer. The read-only passthrough (http-rest/actions.ts)
// deliberately records nothing, so exactly one provenance record exists per
// completed run and the operations log never describes a read as a state change.

export interface WorkflowRunPayload {
  action?: string;
  workflow_run?: {
    id?: number;
    name?: string;
    head_sha?: string;
    status?: string;
    conclusion?: string | null;
    html_url?: string;
    run_number?: number;
    event?: string;
  };
}

// GitHub's conclusion vocabulary is wider than gate_results' three states.
// "cancelled"/"timed_out"/"action_required" are deliberately failures rather
// than pending: a land policy asking for gates_green must not treat a run that
// stopped without succeeding as still in flight, or a cancelled build would
// hold a merge open forever instead of blocking it.
export function mapConclusion(conclusion: string | null | undefined): "success" | "failure" | "pending" {
  switch (conclusion) {
    case "success":
      return "success";
    case "neutral":
    case "skipped":
      // Nothing ran and nothing objected — treated as passing, matching how
      // GitHub's own required-checks logic counts them.
      return "success";
    case "failure":
    case "cancelled":
    case "timed_out":
    case "action_required":
    case "startup_failure":
    case "stale":
      return "failure";
    default:
      return "pending";
  }
}

export interface IngestResult {
  recorded: boolean;
  reason?: string;
  gateName?: string;
}

// Records a completed workflow run as a DSSE-signed gate result.
//
// Only `action: "completed"` is recorded. "requested"/"in_progress" carry no
// verdict, and writing a pending row for them would let a land policy block on
// a gate that never resolves if the run is later deleted upstream.
export async function ingestWorkflowRun(
  db: Db,
  signer: Signer,
  publicUrl: string,
  repo: { id: string; owner: string; name: string },
  reporterId: string,
  payload: WorkflowRunPayload,
): Promise<IngestResult> {
  const run = payload.workflow_run;
  if (payload.action !== "completed") {
    return { recorded: false, reason: `ignored action '${payload.action ?? "(none)"}'` };
  }
  if (!run?.id || !run.head_sha || !run.name) {
    return { recorded: false, reason: "malformed workflow_run payload" };
  }

  // Namespaced so an upstream workflow can never collide with, or silently
  // satisfy, a gate name a repo's own adp.yaml requires.
  const gateName = `actions/${run.name}`;
  const status = mapConclusion(run.conclusion);
  const externalId = `workflow_run:${run.id}`;

  const statement: InTotoStatement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `git+${publicUrl}/${repo.owner}/${repo.name}`, digest: { sha1: run.head_sha } }],
    predicateType: "https://adp.dev/attestations/upstream-workflow-run/v1",
    predicate: {
      provider: "github-actions",
      runId: run.id,
      runNumber: run.run_number ?? null,
      workflow: run.name,
      event: run.event ?? null,
      status: run.status ?? null,
      conclusion: run.conclusion ?? null,
      htmlUrl: run.html_url ?? null,
      // Named explicitly so a verifier can tell relayed upstream evidence from
      // something this instance observed itself.
      ingestedVia: "mirror-webhook",
    },
  };
  const envelope = signStatement(signer, statement);

  const inserted = await db.transaction(async (tx) => {
    // onConflictDoNothing against the partial unique index on
    // (repo_id, external_id): GitHub redelivers webhooks, and the exit
    // criterion is exactly one evidence row per completed run. Enforcing that
    // in the database rather than with a read-then-write also makes it safe
    // against two deliveries racing.
    const rows = await tx
      .insert(gateResults)
      .values({
        repoId: repo.id,
        gitSha: run.head_sha!,
        name: gateName,
        status,
        summary: `${run.name} run #${run.run_number ?? "?"} concluded ${run.conclusion ?? "unknown"}`,
        reporterId,
        envelope,
        externalId,
      })
      .onConflictDoNothing()
      .returning();

    if (rows.length === 0) return null;

    await recordOperation(tx, {
      repoId: repo.id,
      actorId: reporterId,
      verb: "gate.ingest",
      target: `${repo.owner}/${repo.name}@${run.head_sha}#${gateName}`,
      after: { id: rows[0]!.id, runId: run.id, status },
    });

    return rows[0]!;
  });

  if (!inserted) {
    return { recorded: false, reason: `duplicate delivery for ${externalId}`, gateName };
  }
  return { recorded: true, gateName };
}

// The mirror's own system identity is the reporter — evidence that arrived
// from upstream is not attributable to any human, and operations.actorId is a
// hard FK, so there has to be a real row to point at.
export async function resolveMirrorReporter(db: Db, identityId: string | null): Promise<string | null> {
  if (!identityId) return null;
  const [identity] = await db.select().from(identities).where(eq(identities.id, identityId));
  return identity?.id ?? null;
}
