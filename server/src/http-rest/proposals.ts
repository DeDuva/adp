import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "../core/git-backend.js";
import { proposals, changes } from "../db/schema.js";
import { requireScope } from "../auth/plugin.js";
import { recordOperation } from "../core/operations.js";
import { findRepo } from "../core/repos-lookup.js";

const CreateProposalBody = z.object({
  title: z.string().min(1),
  body: z.string().default(""),
  head: z.string().min(1),
  base: z.string().min(1),
  change_id: z.string().uuid().optional(),
});

const UpdateProposalBody = z.object({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  state: z.enum(["open", "closed"]).optional(),
});

function serializeProposal(proposal: typeof proposals.$inferSelect, owner: string, repoName: string) {
  return {
    id: proposal.id,
    number: proposal.number,
    title: proposal.title,
    body: proposal.body,
    state: proposal.state,
    head: { ref: proposal.headRef, sha: proposal.headSha },
    base: { ref: proposal.baseRef },
    change_id: proposal.changeId,
    created_at: proposal.createdAt.toISOString(),
    closed_at: proposal.closedAt?.toISOString() ?? null,
    merged_at: proposal.mergedAt?.toISOString() ?? null,
    html_url: `/${owner}/${repoName}/pulls/${proposal.number}`,
  };
}

export function registerProposalRoutes(app: FastifyInstance, db: Db, gitBackend: GitBackend) {
  app.post(
    "/api/v3/repos/:owner/:repo/pulls",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName } = req.params as { owner: string; repo: string };
      const parsed = CreateProposalBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
        return;
      }

      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const headSha = await gitBackend.resolveRef(owner, repoName, parsed.data.head);
      if (!headSha) {
        reply.code(422).send({ message: `head branch '${parsed.data.head}' not found` });
        return;
      }
      const baseSha = await gitBackend.resolveRef(owner, repoName, parsed.data.base);
      if (!baseSha) {
        reply.code(422).send({ message: `base branch '${parsed.data.base}' not found` });
        return;
      }

      if (parsed.data.change_id) {
        const [change] = await db
          .select()
          .from(changes)
          .where(and(eq(changes.id, parsed.data.change_id), eq(changes.repoId, repo.id)));
        if (!change) {
          reply.code(422).send({ message: `Change ${parsed.data.change_id} not found in this repository` });
          return;
        }
      }

      const proposal = await db.transaction(async (tx) => {
        // Same repo-row-lock pattern as issue numbering (issues.ts) — a
        // second sequence, deliberately not shared with issue numbers (see
        // schema.ts comment on the proposals table).
        await tx.execute(sql`select id from repos where id = ${repo.id} for update`);

        const [row] = await tx
          .select({ nextNumber: sql<number>`coalesce(max(${proposals.number}), 0) + 1` })
          .from(proposals)
          .where(eq(proposals.repoId, repo.id));
        const nextNumber = row!.nextNumber;

        const [proposal] = await tx
          .insert(proposals)
          .values({
            repoId: repo.id,
            number: nextNumber,
            title: parsed.data.title,
            body: parsed.data.body,
            headRef: parsed.data.head,
            headSha,
            baseRef: parsed.data.base,
            changeId: parsed.data.change_id ?? null,
            authorId: req.identity!.identityId,
          })
          .returning();

        await recordOperation(tx, {
          actorId: req.identity!.identityId,
          verb: "proposal.create",
          target: `${owner}/${repoName}#${nextNumber}`,
          after: { id: proposal!.id, head: parsed.data.head, base: parsed.data.base, headSha },
        });

        return proposal!;
      });

      reply.code(201).send(serializeProposal(proposal, owner, repoName));
    },
  );

  app.get("/api/v3/repos/:owner/:repo/pulls", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: repoName } = req.params as { owner: string; repo: string };
    const repo = await findRepo(db, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }
    const rows = await db.select().from(proposals).where(eq(proposals.repoId, repo.id));
    reply.send(rows.map((p) => serializeProposal(p, owner, repoName)));
  });

  app.get("/api/v3/repos/:owner/:repo/pulls/:number", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: repoName, number } = req.params as { owner: string; repo: string; number: string };
    const repo = await findRepo(db, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }
    const [proposal] = await db
      .select()
      .from(proposals)
      .where(and(eq(proposals.repoId, repo.id), eq(proposals.number, Number(number))));
    if (!proposal) {
      reply.code(404).send({ message: "Not Found" });
      return;
    }

    // GitHub overloads this endpoint via Accept: the same resource as a
    // unified diff or patch, not a separate route.
    const accept = req.headers.accept ?? "";
    if (accept.includes("diff") || accept.includes("patch")) {
      const patch = await gitBackend.diffPatch(owner, repoName, proposal.baseRef, proposal.headSha);
      reply.type(accept.includes("patch") ? "text/x-patch" : "text/x-diff").send(patch);
      return;
    }

    reply.send(serializeProposal(proposal, owner, repoName));
  });

  app.get("/api/v3/repos/:owner/:repo/pulls/:number/files", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: repoName, number } = req.params as { owner: string; repo: string; number: string };
    const repo = await findRepo(db, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }
    const [proposal] = await db
      .select()
      .from(proposals)
      .where(and(eq(proposals.repoId, repo.id), eq(proposals.number, Number(number))));
    if (!proposal) {
      reply.code(404).send({ message: "Not Found" });
      return;
    }
    const files = await gitBackend.diffNameStatus(owner, repoName, proposal.baseRef, proposal.headSha);
    reply.send(files.map((f) => ({ filename: f.path, status: f.status })));
  });

  app.patch(
    "/api/v3/repos/:owner/:repo/pulls/:number",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName, number } = req.params as { owner: string; repo: string; number: string };
      const parsed = UpdateProposalBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
        return;
      }

      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const updated = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(proposals)
          .where(and(eq(proposals.repoId, repo.id), eq(proposals.number, Number(number))));
        if (!existing) return null;
        if (existing.state === "merged") return "merged" as const;

        const closing = parsed.data.state === "closed" && existing.state !== "closed";
        const reopening = parsed.data.state === "open" && existing.state !== "open";

        const [updated] = await tx
          .update(proposals)
          .set({
            ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
            ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
            ...(parsed.data.state !== undefined ? { state: parsed.data.state } : {}),
            closedAt: closing ? new Date() : reopening ? null : existing.closedAt,
          })
          .where(eq(proposals.id, existing.id))
          .returning();

        await recordOperation(tx, {
          actorId: req.identity!.identityId,
          verb: closing ? "proposal.close" : reopening ? "proposal.reopen" : "proposal.update",
          target: `${owner}/${repoName}#${number}`,
          before: { title: existing.title, state: existing.state },
          after: { title: updated!.title, state: updated!.state },
        });

        return updated!;
      });

      if (!updated) {
        reply.code(404).send({ message: "Not Found" });
        return;
      }
      if (updated === "merged") {
        reply.code(422).send({ message: "Cannot update a merged proposal" });
        return;
      }
      reply.send(serializeProposal(updated, owner, repoName));
    },
  );

  // Fast-forward only, no evidence/gate check yet — that's M1c's land
  // policy (docs/pragmatic_mvp.md M1c). A non-fast-forward base is exactly
  // the MVP's "conflict": 409, agent rebases and retries, same as it would
  // against a real forge today (cut list, §2.5).
  app.put(
    "/api/v3/repos/:owner/:repo/pulls/:number/merge",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName, number } = req.params as { owner: string; repo: string; number: string };
      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const [proposal] = await db
        .select()
        .from(proposals)
        .where(and(eq(proposals.repoId, repo.id), eq(proposals.number, Number(number))));
      if (!proposal) {
        reply.code(404).send({ message: "Not Found" });
        return;
      }
      if (proposal.state === "merged") {
        reply.code(422).send({ message: "Already merged" });
        return;
      }
      if (proposal.state === "closed") {
        reply.code(422).send({ message: "Cannot merge a closed proposal" });
        return;
      }

      const currentBaseSha = await gitBackend.resolveRef(owner, repoName, proposal.baseRef);
      if (!currentBaseSha) {
        reply.code(422).send({ message: `base branch '${proposal.baseRef}' no longer exists` });
        return;
      }

      const isFastForward = await gitBackend.isAncestor(
        owner,
        repoName,
        currentBaseSha,
        proposal.headSha,
      );
      if (!isFastForward) {
        reply.code(409).send({
          message: `base '${proposal.baseRef}' has diverged from head '${proposal.headRef}' — not a fast-forward, rebase and retry`,
        });
        return;
      }

      const updatedRef = await gitBackend.fastForwardRef(
        owner,
        repoName,
        proposal.baseRef,
        currentBaseSha,
        proposal.headSha,
      );
      if (!updatedRef) {
        reply.code(409).send({ message: `base '${proposal.baseRef}' moved concurrently, retry` });
        return;
      }

      const merged = await db.transaction(async (tx) => {
        const [merged] = await tx
          .update(proposals)
          .set({ state: "merged", mergedAt: new Date() })
          .where(eq(proposals.id, proposal.id))
          .returning();

        await recordOperation(tx, {
          actorId: req.identity!.identityId,
          verb: "proposal.merge",
          target: `${owner}/${repoName}#${number}`,
          before: { baseSha: currentBaseSha },
          after: { baseSha: proposal.headSha, mergedInto: proposal.baseRef },
        });

        return merged!;
      });

      reply.send({ merged: true, sha: proposal.headSha, ...serializeProposal(merged, owner, repoName) });
    },
  );
}
