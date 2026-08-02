import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, desc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { Signer } from "../core/signing.js";
import { gateResults } from "../db/schema.js";
import { requireScope } from "../auth/plugin.js";
import { recordOperation } from "../core/operations.js";
import { findRepo } from "../core/repos-lookup.js";
import { signStatement, type InTotoStatement } from "../core/dsse.js";
import { emitWebhookEvent } from "../core/webhooks.js";

const ReportGateBody = z.object({
  git_sha: z.string().regex(/^[0-9a-f]{40}$/),
  name: z.string().min(1),
  status: z.enum(["success", "failure", "pending"]),
  summary: z.string().default(""),
});

function serializeGateResult(row: typeof gateResults.$inferSelect) {
  return {
    id: row.id,
    git_sha: row.gitSha,
    name: row.name,
    status: row.status,
    summary: row.summary,
    envelope: row.envelope,
    created_at: row.createdAt.toISOString(),
  };
}

// Evidence bundles as DSSE envelopes wrapping in-toto Statements
// (docs/pragmatic_mvp.md §1.5 item 1, M1c). No gate runner executes
// anything here — this server is the *receiving and attestation* end,
// same shape as GitHub's own Checks API (external systems report results;
// GitHub doesn't run the tests either). Scanner-as-gate adapters
// (SARIF/JSON in, DSSE out) are M2 scope; this is the substrate they'll
// report into.
export function registerGateRoutes(app: FastifyInstance, db: Db, signer: Signer, publicUrl: string, credentialKey: string) {
  app.post(
    "/api/v3/repos/:owner/:repo/gates",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName } = req.params as { owner: string; repo: string };
      const parsed = ReportGateBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
        return;
      }

      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const statement: InTotoStatement = {
        _type: "https://in-toto.io/Statement/v1",
        subject: [{ name: `git+${publicUrl}/${owner}/${repoName}`, digest: { sha1: parsed.data.git_sha } }],
        predicateType: "https://adp.dev/attestations/gate-result/v1",
        predicate: {
          gate: parsed.data.name,
          status: parsed.data.status,
          summary: parsed.data.summary,
          reporter: req.identity!.principal,
        },
      };
      const envelope = signStatement(signer, statement);

      const row = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(gateResults)
          .values({
            repoId: repo.id,
            gitSha: parsed.data.git_sha,
            name: parsed.data.name,
            status: parsed.data.status,
            summary: parsed.data.summary,
            reporterId: req.identity!.identityId,
            envelope,
          })
          .returning();

        await recordOperation(tx, {
          repoId: repo.id,
          actorId: req.identity!.identityId,
          verb: "gate.report",
          target: `${owner}/${repoName}@${parsed.data.git_sha}#${parsed.data.name}`,
          after: { status: parsed.data.status },
        });

        return row!;
      });

      emitWebhookEvent(
        db,
        repo.id,
        "gate_result",
        {
          git_sha: parsed.data.git_sha,
          name: parsed.data.name,
          status: parsed.data.status,
          summary: parsed.data.summary,
          repository: { full_name: `${owner}/${repoName}` },
        },
        req.log,
        credentialKey,
      );

      reply.code(201).send(serializeGateResult(row));
    },
  );

  app.get(
    "/api/v3/repos/:owner/:repo/commits/:sha/gates",
    { preHandler: requireScope("repo:read") },
    async (req, reply) => {
      const { owner, repo: repoName, sha } = req.params as { owner: string; repo: string; sha: string };
      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const rows = await db
        .select()
        .from(gateResults)
        .where(and(eq(gateResults.repoId, repo.id), eq(gateResults.gitSha, sha)))
        .orderBy(desc(gateResults.createdAt));

      reply.send(rows.map(serializeGateResult));
    },
  );
}
