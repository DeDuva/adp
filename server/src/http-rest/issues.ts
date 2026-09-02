import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PerPageQuery } from "./pagination.js";
import { validationErrors } from "./validation-errors.js";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { issues, issueComments, intents } from "../db/schema.js";
import { requireScope } from "../auth/plugin.js";
import { recordOperation } from "../core/operations.js";
import { findRepoAuthorized } from "../core/repos-lookup.js";
import { upstreamIngestEnabled } from "../core/mirrors-lookup.js";
import { nativeIssueRefusal } from "../core/issue-ingest.js";

const CreateIssueBody = z.object({
  title: z.string().min(1),
  body: z.string().default(""),
});

const UpdateIssueBody = z.object({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  state: z.enum(["open", "closed"]).optional(),
});

const CreateCommentBody = z.object({
  body: z.string().min(1),
});

function serializeIssue(
  issue: typeof issues.$inferSelect,
  owner: string,
  repoName: string,
  authorLogin: string,
) {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    intent_id: issue.intentId,
    user: { login: authorLogin },
    created_at: issue.createdAt.toISOString(),
    closed_at: issue.closedAt?.toISOString() ?? null,
    html_url: `/${owner}/${repoName}/issues/${issue.number}`,
  };
}

export function registerIssueRoutes(app: FastifyInstance, db: Db) {
  app.post(
    "/api/v3/repos/:owner/:repo/issues",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName } = req.params as { owner: string; repo: string };
      const parsed = CreateIssueBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
        return;
      }

      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      // #226: a shadow issue adopts its upstream number, so on an ingesting
      // repository a natively filed one is a collision waiting for upstream to
      // reach the same number — the same reasoning #224 applies to proposals.
      if (await upstreamIngestEnabled(db, repo.id)) {
        reply.code(409).send(nativeIssueRefusal(owner, repoName));
        return;
      }

      const issue = await db.transaction(async (tx) => {
        // Lock the repo row so two concurrent issue creates can't compute the
        // same next number; Postgres won't serialize this for us otherwise.
        await tx.execute(sql`select id from repos where id = ${repo.id} for update`);

        const [row] = await tx
          .select({ nextNumber: sql<number>`coalesce(max(${issues.number}), 0) + 1` })
          .from(issues)
          .where(eq(issues.repoId, repo.id));
        const nextNumber = row!.nextNumber;

        // Every issue is intent, from the moment it's filed — this is the
        // payload a change's provenance eventually links back to.
        const [intent] = await tx
          .insert(intents)
          .values({
            repoId: repo.id,
            title: parsed.data.title,
            body: parsed.data.body,
            source: "issue",
          })
          .returning();

        const [issue] = await tx
          .insert(issues)
          .values({
            repoId: repo.id,
            number: nextNumber,
            title: parsed.data.title,
            body: parsed.data.body,
            authorId: req.identity!.identityId,
            intentId: intent!.id,
          })
          .returning();

        await recordOperation(tx, {
          repoId: repo.id,
          actorId: req.identity!.identityId,
          verb: "issue.create",
          target: `${owner}/${repoName}#${nextNumber}`,
          after: { id: issue!.id, title: parsed.data.title, state: "open" },
        });

        return issue!;
      });

      reply.code(201).send(serializeIssue(issue, owner, repoName, req.identity!.principal));
    },
  );

  app.get("/api/v3/repos/:owner/:repo/issues", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: repoName } = req.params as { owner: string; repo: string };
    const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }

    // #97: bounded, GitHub's way (per_page<=100, page offsets) — gh and
    // Octokit already send exactly these.
    const { per_page, page } = PerPageQuery.parse(req.query ?? {});
    const rows = await db
      .select()
      .from(issues)
      .where(eq(issues.repoId, repo.id))
      .orderBy(desc(issues.number))
      .limit(per_page)
      .offset((page - 1) * per_page);
    reply.send(rows.map((issue) => serializeIssue(issue, owner, repoName, "")));
  });

  app.get("/api/v3/repos/:owner/:repo/issues/:number", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: repoName, number } = req.params as {
      owner: string;
      repo: string;
      number: string;
    };
    const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }

    const [issue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.repoId, repo.id), eq(issues.number, Number(number))));
    if (!issue) {
      reply.code(404).send({ message: "Not Found" });
      return;
    }
    reply.send(serializeIssue(issue, owner, repoName, ""));
  });

  app.patch(
    "/api/v3/repos/:owner/:repo/issues/:number",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName, number } = req.params as {
        owner: string;
        repo: string;
        number: string;
      };
      const parsed = UpdateIssueBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
        return;
      }

      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const updated = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(issues)
          .where(and(eq(issues.repoId, repo.id), eq(issues.number, Number(number))));
        if (!existing) return null;

        const closing = parsed.data.state === "closed" && existing.state !== "closed";
        const reopening = parsed.data.state === "open" && existing.state !== "open";

        const [updated] = await tx
          .update(issues)
          .set({
            ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
            ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
            ...(parsed.data.state !== undefined ? { state: parsed.data.state } : {}),
            closedAt: closing ? new Date() : reopening ? null : existing.closedAt,
          })
          .where(eq(issues.id, existing.id))
          .returning();

        await recordOperation(tx, {
          repoId: repo.id,
          actorId: req.identity!.identityId,
          verb: closing ? "issue.close" : reopening ? "issue.reopen" : "issue.update",
          target: `${owner}/${repoName}#${number}`,
          before: { title: existing.title, body: existing.body, state: existing.state },
          after: { title: updated!.title, body: updated!.body, state: updated!.state },
        });

        return updated!;
      });

      if (!updated) {
        reply.code(404).send({ message: "Not Found" });
        return;
      }
      reply.send(serializeIssue(updated, owner, repoName, req.identity!.principal));
    },
  );

  app.post(
    "/api/v3/repos/:owner/:repo/issues/:number/comments",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName, number } = req.params as {
        owner: string;
        repo: string;
        number: string;
      };
      const parsed = CreateCommentBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
        return;
      }

      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const [issue] = await db
        .select()
        .from(issues)
        .where(and(eq(issues.repoId, repo.id), eq(issues.number, Number(number))));
      if (!issue) {
        reply.code(404).send({ message: "Not Found" });
        return;
      }

      const comment = await db.transaction(async (tx) => {
        const [comment] = await tx
          .insert(issueComments)
          .values({
            issueId: issue.id,
            authorId: req.identity!.identityId,
            body: parsed.data.body,
          })
          .returning();

        await recordOperation(tx, {
          repoId: repo.id,
          actorId: req.identity!.identityId,
          verb: "issue.comment.create",
          target: `${owner}/${repoName}#${number}`,
          after: { id: comment!.id },
        });

        return comment!;
      });

      reply.code(201).send({
        id: comment.id,
        body: comment.body,
        user: { login: req.identity!.principal },
        created_at: comment.createdAt.toISOString(),
      });
    },
  );

  app.get("/api/v3/repos/:owner/:repo/issues/:number/comments", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: repoName, number } = req.params as {
      owner: string;
      repo: string;
      number: string;
    };
    const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
    if (!repo) {
      reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
      return;
    }

    const [issue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.repoId, repo.id), eq(issues.number, Number(number))));
    if (!issue) {
      reply.code(404).send({ message: "Not Found" });
      return;
    }

    const { per_page, page } = PerPageQuery.parse(req.query ?? {});
    const rows = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id))
      .orderBy(asc(issueComments.createdAt))
      .limit(per_page)
      .offset((page - 1) * per_page);
    reply.send(
      rows.map((comment) => ({
        id: comment.id,
        body: comment.body,
        created_at: comment.createdAt.toISOString(),
      })),
    );
  });
}
