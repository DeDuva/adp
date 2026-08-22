import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PerPageQuery } from "./pagination.js";
import { validationErrors } from "./validation-errors.js";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { proposals, reviews } from "../db/schema.js";
import { requireScope } from "../auth/plugin.js";
import { recordOperation } from "../core/operations.js";
import { findRepoAuthorized } from "../core/repos-lookup.js";

const CreateReviewBody = z.object({
  state: z.enum(["approved", "changes_requested", "commented"]),
  body: z.string().default(""),
  annotations: z
    .array(z.object({ file: z.string(), line: z.number().int().positive(), body: z.string() }))
    .optional(),
});

function serializeReview(review: typeof reviews.$inferSelect) {
  return {
    id: review.id,
    state: review.state,
    body: review.body,
    annotations: review.annotations,
    created_at: review.createdAt.toISOString(),
  };
}

// Typed review state, not an emoji thread — one of the MVP's core claims
// (docs/pragmatic_mvp.md §2.3, rubric step 7). Positional inline comments
// (file/line/side) are best-effort annotations, not GitHub's diff-position
// model — that's an explicit cut (§2.5).
export function registerReviewRoutes(app: FastifyInstance, db: Db) {
  app.post(
    "/api/v3/repos/:owner/:repo/pulls/:number/reviews",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName, number } = req.params as { owner: string; repo: string; number: string };
      const parsed = CreateReviewBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
        return;
      }

      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
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

      const review = await db.transaction(async (tx) => {
        const [review] = await tx
          .insert(reviews)
          .values({
            proposalId: proposal.id,
            reviewerId: req.identity!.identityId,
            state: parsed.data.state,
            body: parsed.data.body,
            annotations: parsed.data.annotations ?? null,
          })
          .returning();

        await recordOperation(tx, {
          repoId: repo.id,
          actorId: req.identity!.identityId,
          verb: "review.create",
          target: `${owner}/${repoName}#${number}`,
          after: { id: review!.id, state: parsed.data.state },
        });

        return review!;
      });

      reply.code(201).send(serializeReview(review));
    },
  );

  app.get("/api/v3/repos/:owner/:repo/pulls/:number/reviews", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: repoName, number } = req.params as { owner: string; repo: string; number: string };
    const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
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

    const { per_page, page } = PerPageQuery.parse(req.query ?? {});
    const rows = await db
      .select()
      .from(reviews)
      .where(eq(reviews.proposalId, proposal.id))
      .orderBy(asc(reviews.createdAt))
      .limit(per_page)
      .offset((page - 1) * per_page);
    reply.send(rows.map(serializeReview));
  });
}
