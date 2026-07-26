import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "../core/git-backend.js";
import { repos, operations } from "../db/schema.js";
import { requireAuth } from "../auth/plugin.js";

const CreateRepoBody = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9._-]+$/),
  default_branch: z.string().min(1).default("main"),
});

export function registerRepoRoutes(app: FastifyInstance, db: Db, gitBackend: GitBackend) {
  app.post("/api/v3/repos/:owner", { preHandler: requireAuth }, async (req, reply) => {
    const { owner } = req.params as { owner: string };
    const parsed = CreateRepoBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
      return;
    }
    const { name, default_branch } = parsed.data;

    const existing = await db
      .select()
      .from(repos)
      .where(and(eq(repos.owner, owner), eq(repos.name, name)));
    if (existing.length > 0) {
      reply.code(422).send({ message: `Repository ${owner}/${name} already exists` });
      return;
    }

    await gitBackend.initBareRepo(owner, name, default_branch);

    const [repo] = await db
      .insert(repos)
      .values({ owner, name, defaultBranch: default_branch })
      .returning();

    await db.insert(operations).values({
      actorId: req.identity!.identityId,
      verb: "repo.create",
      target: `${owner}/${name}`,
      before: null,
      after: { id: repo!.id, owner, name, defaultBranch: default_branch },
    });

    reply.code(201).send({
      id: repo!.id,
      full_name: `${owner}/${name}`,
      name,
      owner: { login: owner },
      default_branch,
      clone_url: `${req.protocol}://${req.hostname}/${owner}/${name}.git`,
    });
  });

  app.get("/api/v3/repos/:owner/:repo", async (req, reply) => {
    const { owner, repo: name } = req.params as { owner: string; repo: string };
    const [repo] = await db
      .select()
      .from(repos)
      .where(and(eq(repos.owner, owner), eq(repos.name, name)));
    if (!repo) {
      reply.code(404).send({ message: "Not Found" });
      return;
    }
    reply.send({
      id: repo.id,
      full_name: `${owner}/${name}`,
      name,
      owner: { login: owner },
      default_branch: repo.defaultBranch,
      clone_url: `${req.protocol}://${req.hostname}/${owner}/${name}.git`,
    });
  });
}
