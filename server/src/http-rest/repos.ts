import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { count, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "../core/git-backend.js";
import { orgs, repos } from "../db/schema.js";
import { requireScope } from "../auth/plugin.js";
import { recordOperation } from "../core/operations.js";
import { findRepo } from "../core/repos-lookup.js";
import { findOrCreateOrg } from "../core/org-lookup.js";

const CreateRepoBody = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9._-]+$/),
  default_branch: z.string().min(1).default("main"),
});

async function createRepo(
  db: Db,
  gitBackend: GitBackend,
  owner: string,
  name: string,
  defaultBranch: string,
  actorId: string,
) {
  if (await findRepo(db, owner, name)) {
    return { status: "conflict" as const };
  }

  // M4-3: every repo gets an org going forward, the same org the M4-0
  // migration would have backfilled this owner string into if the repo had
  // predated it — one org per distinct owner, found-or-created here rather
  // than left null, which is what makes maxRepos below able to mean anything.
  const orgId = await findOrCreateOrg(db, owner);
  const [org] = await db.select({ maxRepos: orgs.maxRepos }).from(orgs).where(eq(orgs.id, orgId));
  if (org?.maxRepos != null) {
    const [row] = await db.select({ existing: count() }).from(repos).where(eq(repos.orgId, orgId));
    if ((row?.existing ?? 0) >= org.maxRepos) {
      return { status: "quota-exceeded" as const, maxRepos: org.maxRepos };
    }
  }

  // git init happens outside the DB transaction (it's not transactional
  // infrastructure), but the repo row and its op-log entry are atomic.
  await gitBackend.initBareRepo(owner, name, defaultBranch);

  const repo = await db.transaction(async (tx) => {
    const [repo] = await tx.insert(repos).values({ owner, name, defaultBranch, orgId }).returning();

    await recordOperation(tx, {
      repoId: repo!.id,
      actorId,
      verb: "repo.create",
      target: `${owner}/${name}`,
      after: { id: repo!.id, owner, name, defaultBranch, orgId },
    });

    return repo!;
  });

  return { status: "created" as const, repo };
}

function serializeRepo(repo: typeof repos.$inferSelect, owner: string, name: string, publicUrl: string) {
  return {
    id: repo.id,
    full_name: `${owner}/${name}`,
    name,
    owner: { login: owner },
    default_branch: repo.defaultBranch,
    clone_url: cloneUrl(publicUrl, owner, name),
  };
}

// Built from PUBLIC_URL, never from req.protocol/req.hostname. Behind a
// TLS-terminating proxy (deploy/ runs Caddy) the request reaching Fastify is
// plain HTTP, so req.protocol is "http" — and a client that trusts the
// advertised URL then fails outright, because git drops credentials when a
// redirect changes protocol:
//   fatal: Authentication failed for 'http://<host>/<owner>/<repo>.git/'
// PUBLIC_URL is already defined as "the public hostname gh and git clients
// will hit" (deploy/.env.example), which makes it the authoritative answer
// and avoids having to decide who may spoof X-Forwarded-Proto.
export function cloneUrl(publicUrl: string, owner: string, name: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/${owner}/${name}.git`;
}

export function registerRepoRoutes(app: FastifyInstance, db: Db, gitBackend: GitBackend, publicUrl: string) {
  app.post("/api/v3/repos/:owner", { preHandler: requireScope("repo:write") }, async (req, reply) => {
    const { owner } = req.params as { owner: string };
    const parsed = CreateRepoBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
      return;
    }
    const { name, default_branch } = parsed.data;

    const result = await createRepo(db, gitBackend, owner, name, default_branch, req.identity!.identityId);
    if (result.status === "conflict") {
      reply.code(422).send({ message: `Repository ${owner}/${name} already exists` });
      return;
    }
    if (result.status === "quota-exceeded") {
      reply.code(403).send({ message: `Org repo quota exceeded (max ${result.maxRepos})` });
      return;
    }
    reply.code(201).send(serializeRepo(result.repo, owner, name, publicUrl));
  });

  // GitHub-standard repo-create paths — the owner is implicit (the caller's
  // own login, or the named org), unlike /api/v3/repos/:owner above which
  // predates this and takes the owner explicitly in the path.
  app.post("/api/v3/user/repos", { preHandler: requireScope("repo:write") }, async (req, reply) => {
    const parsed = CreateRepoBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
      return;
    }
    const owner = req.identity!.principal;
    const { name, default_branch } = parsed.data;

    const result = await createRepo(db, gitBackend, owner, name, default_branch, req.identity!.identityId);
    if (result.status === "conflict") {
      reply.code(422).send({ message: `Repository ${owner}/${name} already exists` });
      return;
    }
    if (result.status === "quota-exceeded") {
      reply.code(403).send({ message: `Org repo quota exceeded (max ${result.maxRepos})` });
      return;
    }
    reply.code(201).send(serializeRepo(result.repo, owner, name, publicUrl));
  });

  app.post("/api/v3/orgs/:org/repos", { preHandler: requireScope("repo:write") }, async (req, reply) => {
    const { org } = req.params as { org: string };
    const parsed = CreateRepoBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
      return;
    }
    const { name, default_branch } = parsed.data;

    const result = await createRepo(db, gitBackend, org, name, default_branch, req.identity!.identityId);
    if (result.status === "conflict") {
      reply.code(422).send({ message: `Repository ${org}/${name} already exists` });
      return;
    }
    if (result.status === "quota-exceeded") {
      reply.code(403).send({ message: `Org repo quota exceeded (max ${result.maxRepos})` });
      return;
    }
    reply.code(201).send(serializeRepo(result.repo, org, name, publicUrl));
  });

  app.get("/api/v3/repos/:owner/:repo", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const { owner, repo: name } = req.params as { owner: string; repo: string };
    const repo = await findRepo(db, owner, name);
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
      clone_url: cloneUrl(publicUrl, owner, name),
    });
  });
}
