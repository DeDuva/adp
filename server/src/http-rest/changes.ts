import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "../core/git-backend.js";
import type { Signer } from "../core/signing.js";
import { changes, intents } from "../db/schema.js";
import { requireScope } from "../auth/plugin.js";
import { recordOperation } from "../core/operations.js";
import { findRepo } from "../core/repos-lookup.js";
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
// ADP metadata living beside a git commit (docs/pragmatic_mvp.md §2.2).
// Recorded via an explicit call rather than a git post-receive hook for now;
// wiring automatic recording into the push path is follow-up work.
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
        reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
        return;
      }

      const repo = await findRepo(db, owner, repoName);
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

      const provenance = provenanceOf(req.identity!);
      const signature = signer.sign({
        repo: `${owner}/${repoName}`,
        git_sha: parsed.data.git_sha,
        intent_id: parsed.data.intent_id ?? null,
        provenance,
      });

      const change = await db.transaction(async (tx) => {
        const [change] = await tx
          .insert(changes)
          .values({
            repoId: repo.id,
            gitSha: parsed.data.git_sha,
            intentId: parsed.data.intent_id ?? null,
            workspaceId: parsed.data.workspace_id ?? null,
            provenance,
            signature,
          })
          .returning();

        await recordOperation(tx, {
          actorId: req.identity!.identityId,
          verb: "change.create",
          target: `${owner}/${repoName}@${parsed.data.git_sha}`,
          after: { id: change!.id, gitSha: parsed.data.git_sha, intentId: parsed.data.intent_id ?? null },
        });

        return change!;
      });

      reply.code(201).send(serializeChange(change, owner, repoName));
    },
  );

  app.get("/api/v3/repos/:owner/:repo/changes/:id", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: repoName, id } = req.params as { owner: string; repo: string; id: string };
    const repo = await findRepo(db, owner, repoName);
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
