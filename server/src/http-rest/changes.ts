import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { validationErrors } from "./validation-errors.js";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "../core/git-backend.js";
import type { Signer } from "../core/signing.js";
import { changes, intents } from "../db/schema.js";
import { requireScope } from "../auth/plugin.js";
import { recordOperation } from "../core/operations.js";
import { findRepoAuthorized } from "../core/repos-lookup.js";
import type { AuthenticatedIdentity } from "../auth/tokens.js";

const CreateChangeBody = z.object({
  git_sha: z.string().regex(/^[0-9a-f]{40}$/),
  intent_id: z.string().uuid().optional(),
  workspace_id: z.string().uuid().optional(),
});

function provenanceOf(identity: AuthenticatedIdentity) {
  return {
    kind: identity.kind,
    principal: identity.principal,
    ...(identity.harness ? { harness: identity.harness } : {}),
    ...(identity.model ? { model: identity.model } : {}),
    ...(identity.sessionId ? { session_id: identity.sessionId } : {}),
  };
}

function serializeChange(change: typeof changes.$inferSelect, owner: string, repoName: string) {
  return {
    id: change.id,
    repo: `${owner}/${repoName}`,
    git_sha: change.gitSha,
    intent_id: change.intentId,
    workspace_id: change.workspaceId,
    provenance: change.provenance,
    signature: change.signature,
    created_at: change.createdAt.toISOString(),
  };
}

// The typed change record: diff (referenced by git_sha, not duplicated) +
// intent + provenance, signed. No GitHub shape exists for this — it's native
// ADP metadata living beside a git commit.
//
// #142 wired automatic recording into the push path, which made this route the
// *second* writer of a `changes` row for the same commit, and #143 is what that
// cost: this route inserted unconditionally, `changes` was indexed but not
// unique on (repo_id, git_sha), and the documented push-then-bind sequence
// therefore left two rows for one sha — one auto-recorded and unbound, one
// explicit and bound — which the evidence read then chose between unordered.
//
// So it is an upsert now: one row per sha, and this route *completes* the row
// the push recorded rather than growing a sibling beside it.
export function registerChangeRoutes(
  app: FastifyInstance,
  db: Db,
  gitBackend: GitBackend,
  signer: Signer,
) {
  app.post(
    "/api/v3/repos/:owner/:repo/changes",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName } = req.params as { owner: string; repo: string };
      const parsed = CreateChangeBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
        return;
      }

      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      if (!(await gitBackend.commitExists(owner, repoName, parsed.data.git_sha))) {
        reply.code(422).send({ message: `${parsed.data.git_sha} is not a commit in this repository` });
        return;
      }

      if (parsed.data.intent_id) {
        const [intent] = await db
          .select()
          .from(intents)
          .where(and(eq(intents.id, parsed.data.intent_id), eq(intents.repoId, repo.id)));
        if (!intent) {
          reply.code(422).send({ message: `Intent ${parsed.data.intent_id} not found in this repository` });
          return;
        }
      }

      const [existing] = await db
        .select()
        .from(changes)
        .where(and(eq(changes.repoId, repo.id), eq(changes.gitSha, parsed.data.git_sha)));

      // Rebinding is a claim about the past, so it is refused rather than
      // performed. A change whose intent moved would mean the signed record
      // said one thing yesterday and another today over the same commit — and
      // the signature would verify both times, which is worse than not having
      // one. Filling a null is not rebinding: it is the second half of a
      // sequence (`git push`, then bind) that was always meant to produce one
      // record. Re-posting the same intent is therefore a no-op success, and
      // the same rule covers workspace_id, because "which workspace produced
      // this commit" is the same kind of claim.
      if (existing) {
        for (const [field, incoming, held] of [
          ["intent_id", parsed.data.intent_id, existing.intentId],
          ["workspace_id", parsed.data.workspace_id, existing.workspaceId],
        ] as const) {
          if (incoming && held && incoming !== held) {
            reply.code(409).send({
              message:
                `${parsed.data.git_sha} is already bound to ${field} ${held}. ` +
                `A change's binding is a claim about what produced that commit, so it is ` +
                `recorded once and not rewritten; record a new commit to state something else.`,
            });
            return;
          }
        }
      }

      const intentId = parsed.data.intent_id ?? existing?.intentId ?? null;
      const workspaceId = parsed.data.workspace_id ?? existing?.workspaceId ?? null;

      // On an update the provenance stays the one already recorded. It names
      // who produced the commit — the push — and this call is a binding rather
      // than a second origin story; who bound it is in the operation log,
      // where an actor belongs. On a create there is nothing recorded yet, so
      // it is this caller's.
      const provenance = existing ? existing.provenance : provenanceOf(req.identity!);

      // Re-signed on update, not merely re-stored: the signature covers
      // intent_id, so a row that gains a binding must gain a signature over
      // the binding or the two disagree.
      const signature = signer.sign({
        repo: `${owner}/${repoName}`,
        git_sha: parsed.data.git_sha,
        intent_id: intentId,
        provenance,
      });

      const change = await db.transaction(async (tx) => {
        if (existing) {
          const [updated] = await tx
            .update(changes)
            .set({ intentId, workspaceId, signature })
            .where(eq(changes.id, existing.id))
            .returning();

          await recordOperation(tx, {
            repoId: repo.id,
            actorId: req.identity!.identityId,
            verb: "change.update",
            target: `${owner}/${repoName}@${parsed.data.git_sha}`,
            before: { id: existing.id, intentId: existing.intentId, workspaceId: existing.workspaceId },
            after: { id: updated!.id, gitSha: parsed.data.git_sha, intentId, workspaceId },
          });

          return updated!;
        }

        const [created] = await tx
          .insert(changes)
          .values({
            repoId: repo.id,
            gitSha: parsed.data.git_sha,
            intentId,
            workspaceId,
            provenance,
            signature,
          })
          .returning();

        await recordOperation(tx, {
          repoId: repo.id,
          actorId: req.identity!.identityId,
          verb: "change.create",
          target: `${owner}/${repoName}@${parsed.data.git_sha}`,
          after: { id: created!.id, gitSha: parsed.data.git_sha, intentId },
        });

        return created!;
      });

      // 201 on both paths. The alternative — 200 for the update — would flip
      // the documented push-then-bind sequence from 201 to 200, which
      // docs/api-compatibility.md prices as a major bump; paying that to
      // report an implementation detail of a bug fix is not a trade worth
      // making. `created_at` already distinguishes the two for anyone who
      // needs to: on an update it is the push's timestamp, not this call's.
      reply.code(201).send(serializeChange(change, owner, repoName));
    },
  );

  app.get("/api/v3/repos/:owner/:repo/changes/:id", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: repoName, id } = req.params as { owner: string; repo: string; id: string };
    const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }

    const [change] = await db
      .select()
      .from(changes)
      .where(and(eq(changes.id, id), eq(changes.repoId, repo.id)));
    if (!change) {
      reply.code(404).send({ message: "Not Found" });
      return;
    }
    reply.send(serializeChange(change, owner, repoName));
  });
}
