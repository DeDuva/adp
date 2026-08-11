import type { Db } from "../db/client.js";
import type { Signer } from "./signing.js";
import { gateResults } from "../db/schema.js";
import { signStatement, type InTotoStatement } from "./dsse.js";
import { recordOperation } from "./operations.js";
import { emitWebhookEvent, type WebhookLogger } from "./webhooks.js";

export interface RecordGateResultParams {
  repoId: string;
  owner: string;
  repoName: string;
  gitSha: string;
  name: string;
  status: "success" | "failure" | "pending";
  summary: string;
  reporterId: string;
  reporterPrincipal: string;
  // Set only by callers that can be redelivered/retried for the same real
  // event (M4-9c's gate-job completion) — gets the same
  // (repo_id, external_id) dedup core/actions-ingest.ts already relies on
  // for upstream Actions redelivery. http-rest/gates.ts's self-report route
  // leaves this unset: a human or CI re-POSTing is a new report, not a
  // redelivery of the same one.
  externalId?: string;
}

// The DSSE-signed-evidence shape http-rest/gates.ts's self-report route
// established, factored out so M4-9c's gate-job completion produces
// byte-for-byte the same kind of `gate_results` row — land policy's
// gates_green/gates_confident (core/land-policy.ts) reads `gate_results`
// without caring which path put a row there.
export async function recordGateResult(
  db: Db,
  signer: Signer,
  publicUrl: string,
  credentialKey: string,
  params: RecordGateResultParams,
  log: WebhookLogger,
): Promise<typeof gateResults.$inferSelect | null> {
  const statement: InTotoStatement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `git+${publicUrl}/${params.owner}/${params.repoName}`, digest: { sha1: params.gitSha } }],
    predicateType: "https://adp.dev/attestations/gate-result/v1",
    predicate: {
      gate: params.name,
      status: params.status,
      summary: params.summary,
      reporter: params.reporterPrincipal,
    },
  };
  const envelope = signStatement(signer, statement);

  const row = await db.transaction(async (tx) => {
    const insert = tx.insert(gateResults).values({
      repoId: params.repoId,
      gitSha: params.gitSha,
      name: params.name,
      status: params.status,
      summary: params.summary,
      reporterId: params.reporterId,
      envelope,
      externalId: params.externalId ?? null,
    });
    const rows = params.externalId ? await insert.onConflictDoNothing().returning() : await insert.returning();
    if (rows.length === 0) return null;

    await recordOperation(tx, {
      repoId: params.repoId,
      actorId: params.reporterId,
      verb: "gate.report",
      target: `${params.owner}/${params.repoName}@${params.gitSha}#${params.name}`,
      after: { status: params.status },
    });
    return rows[0]!;
  });

  if (row) {
    emitWebhookEvent(
      db,
      params.repoId,
      "gate_result",
      {
        git_sha: params.gitSha,
        name: params.name,
        status: params.status,
        summary: params.summary,
        repository: { full_name: `${params.owner}/${params.repoName}` },
      },
      log,
      credentialKey,
    );
  }
  return row;
}
