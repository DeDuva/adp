import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import type { Signer } from "../core/signing.js";
import { gateResults } from "../db/schema.js";
import { requireScope } from "../auth/plugin.js";
import { recordOperation } from "../core/operations.js";
import { findRepo } from "../core/repos-lookup.js";
import { signStatement, type InTotoStatement } from "../core/dsse.js";
import { evaluateDependencies } from "../core/dependency-admission.js";

const DependencyAdmissionBody = z.object({
  git_sha: z.string().regex(/^[0-9a-f]{40}$/),
  packages: z
    .array(z.object({ ecosystem: z.string().min(1), name: z.string().min(1), version: z.string().min(1) }))
    .min(1),
  gate_name: z.string().min(1).default("dependency-admission"),
});

// Dependency admission v0 (docs/pragmatic_mvp.md M2): a typed gate a
// lockfile diff reports into, same receiving-and-attestation shape as
// core/dependency-admission.ts and http-rest/gates.ts's plain gate report —
// the difference is this endpoint runs the OSV + npm-registry evaluation
// itself rather than trusting a caller-supplied status, and returns the
// full per-package verdict list, not just a pass/fail summary. Land policy
// needs no new code: a repo lists this route's `gate_name` under adp.yaml's
// `gates:` and gates_green (core/gate-results-lookup.ts) already treats a
// "pending" quarantine verdict as not-green, exactly the way a hard failure
// would be.
export function registerDependencyAdmissionRoutes(app: FastifyInstance, db: Db, signer: Signer, publicUrl: string) {
  app.post(
    "/api/v3/repos/:owner/:repo/dependency-admission",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName } = req.params as { owner: string; repo: string };
      const parsed = DependencyAdmissionBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
        return;
      }

      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      let result;
      try {
        result = await evaluateDependencies(parsed.data.packages);
      } catch (err) {
        // A network/registry failure is not the same as "the dependencies
        // are fine" — surfaced as a typed error, not a silently-admitted
        // gate.
        reply.code(502).send({ message: err instanceof Error ? err.message : "dependency admission check failed" });
        return;
      }

      const statement: InTotoStatement = {
        _type: "https://in-toto.io/Statement/v1",
        subject: [{ name: `git+${publicUrl}/${owner}/${repoName}`, digest: { sha1: parsed.data.git_sha } }],
        predicateType: "https://adp.dev/attestations/dependency-admission/v1",
        predicate: {
          gate: parsed.data.gate_name,
          status: result.status,
          summary: result.summary,
          verdicts: result.verdicts,
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
            name: parsed.data.gate_name,
            status: result.status,
            summary: result.summary,
            reporterId: req.identity!.identityId,
            envelope,
          })
          .returning();

        await recordOperation(tx, {
          repoId: repo.id,
          actorId: req.identity!.identityId,
          verb: "gate.report",
          target: `${owner}/${repoName}@${parsed.data.git_sha}#${parsed.data.gate_name}`,
          after: { status: result.status },
        });

        return row!;
      });

      reply.code(201).send({
        id: row.id,
        git_sha: row.gitSha,
        name: row.name,
        status: row.status,
        summary: row.summary,
        // Typed per-package verdicts, returned to the authoring agent
        // directly — not just buried in the DSSE envelope's predicate.
        packages: result.verdicts,
        envelope: row.envelope,
        created_at: row.createdAt.toISOString(),
      });
    },
  );
}
