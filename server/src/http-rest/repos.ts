import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { validationErrors } from "./validation-errors.js";
import { and, count, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "../core/git-backend.js";
import { orgs, repos } from "../db/schema.js";
import { requireScope } from "../auth/plugin.js";
import { recordOperation } from "../core/operations.js";
import { findRepo, findRepoAuthorized, mayAccessOrg } from "../core/repos-lookup.js";
import { isSafeRepoSegment } from "../core/git-backend.js";
import type { AuthenticatedIdentity } from "../auth/tokens.js";

const CreateRepoBody = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9._-]+$/),
  default_branch: z.string().min(1).default("main"),
});

// The Postgres error code for a unique-constraint violation. Depending on
// where in the driver/ORM stack it surfaces, the pg DatabaseError may be the
// thrown error itself or sit behind one or more `cause` links — walk them.
function isUniqueViolation(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause as Error | undefined) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

async function createRepo(
  db: Db,
  gitBackend: GitBackend,
  owner: string,
  name: string,
  defaultBranch: string,
  identity: AuthenticatedIdentity,
) {
  const actorId = identity.identityId;
  // The owner comes from a route path param (or the token's principal), not
  // the zod-validated body — and find-my-way %2F-decodes params, so without
  // this check "..%2F..%2Ftmp%2Fx" reaches path.join in git-backend.ts as a
  // traversal AND becomes the name of a real orgs row (#89, audit §P0-5).
  if (!isSafeRepoSegment(owner)) {
    return { status: "invalid-owner" as const };
  }

  // Fast path only — the authority on uniqueness is the repos_owner_name_idx
  // unique index, enforced inside the insert transaction below. This check
  // just spares the common duplicate-create the git-init side effects.
  if (await findRepo(db, owner, name)) {
    return { status: "conflict" as const };
  }

  // #91 (audit §P0-2): the org must already exist, and the caller must be
  // allowed in it. This used to be findOrCreateOrg — naming an unseen owner
  // string silently *created* an org, which made the caller its de facto
  // first owner and made the per-org maxRepos quota trivially escapable
  // (hit the cap, POST under a fresh owner, get a new unlimited org).
  // Provisioning an org is now an explicit, audited action (POST
  // /api/adp/orgs, or bootstrap --org at the host).
  const [org] = await db.select().from(orgs).where(eq(orgs.name, owner));
  if (!org) {
    return { status: "no-such-org" as const };
  }
  if (!(await mayAccessOrg(db, identity, org.id))) {
    return { status: "not-a-member" as const };
  }

  // #94 (audit §P1-3): everything that admits the repo happens inside ONE
  // transaction, serialized on the org row. The count-then-insert used to
  // straddle the transaction boundary, so two concurrent creates both saw
  // count = cap - 1, both passed, and the "hard ceiling" was advisory
  // exactly when it was being contended. The FOR UPDATE on orgs is the
  // budget token: same-org creates queue behind it for the few milliseconds
  // an admission takes, different orgs never touch each other's.
  //
  // git init moved inside too, after the lock and the re-checks: two
  // concurrent creates of one repo used to both run `git init`/`git config`
  // on the same directory, and the loser could 500 out of a config.lock
  // collision instead of getting its 422. Holding a row lock across the
  // subprocess (~tens of ms) is the price of the loser never touching the
  // filesystem at all; the unique index stays as the backstop for anything
  // the lock doesn't cover (e.g. a same-name create under a different
  // org... which cannot exist, but the constraint doesn't need the lock to
  // be right).
  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select id from ${orgs} where id = ${org.id} for update`);

      // Re-checks under the lock — the unlocked reads above are fast paths.
      const [existing] = await tx
        .select({ id: repos.id })
        .from(repos)
        .where(and(eq(repos.owner, owner), eq(repos.name, name)));
      if (existing) return { status: "conflict" as const };

      if (org.maxRepos != null) {
        const [row] = await tx.select({ existing: count() }).from(repos).where(eq(repos.orgId, org.id));
        if ((row?.existing ?? 0) >= org.maxRepos) {
          return { status: "quota-exceeded" as const, maxRepos: org.maxRepos };
        }
      }

      await gitBackend.initBareRepo(owner, name, defaultBranch);

      const [repo] = await tx.insert(repos).values({ owner, name, defaultBranch, orgId: org.id }).returning();

      await recordOperation(tx, {
        repoId: repo!.id,
        actorId,
        verb: "repo.create",
        target: `${owner}/${name}`,
        after: { id: repo!.id, owner, name, defaultBranch, orgId: org.id },
      });

      return { status: "created" as const, repo: repo! };
    });
    return result;
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { status: "conflict" as const };
    }
    throw err;
  }
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
      reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
      return;
    }
    const { name, default_branch } = parsed.data;

    const result = await createRepo(db, gitBackend, owner, name, default_branch, req.identity!);
    if (result.status === "invalid-owner") {
      reply.code(422).send({ message: `Validation failed: owner '${owner}' is not a valid repository owner` });
      return;
    }
    if (result.status === "conflict") {
      reply.code(422).send({ message: `Repository ${owner}/${name} already exists` });
      return;
    }
    if (result.status === "no-such-org") {
      reply.code(404).send({ message: "Organization not found - orgs are provisioned explicitly (POST /api/adp/orgs)" });
      return;
    }
    if (result.status === "not-a-member") {
      reply.code(403).send({ message: "Not a member of this organization" });
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
      reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
      return;
    }
    const owner = req.identity!.principal;
    const { name, default_branch } = parsed.data;

    const result = await createRepo(db, gitBackend, owner, name, default_branch, req.identity!);
    if (result.status === "invalid-owner") {
      // The owner here is the token's own principal — minted by an operator,
      // not typed by the caller — so a rejection means the principal itself
      // is not usable as a path/org segment. Fail closed and say so.
      reply.code(422).send({ message: `Validation failed: principal '${owner}' is not a valid repository owner` });
      return;
    }
    if (result.status === "conflict") {
      reply.code(422).send({ message: `Repository ${owner}/${name} already exists` });
      return;
    }
    if (result.status === "no-such-org") {
      reply.code(404).send({ message: "Organization not found - orgs are provisioned explicitly (POST /api/adp/orgs)" });
      return;
    }
    if (result.status === "not-a-member") {
      reply.code(403).send({ message: "Not a member of this organization" });
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
      reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
      return;
    }
    const { name, default_branch } = parsed.data;

    const result = await createRepo(db, gitBackend, org, name, default_branch, req.identity!);
    if (result.status === "invalid-owner") {
      reply.code(422).send({ message: `Validation failed: org '${org}' is not a valid repository owner` });
      return;
    }
    if (result.status === "conflict") {
      reply.code(422).send({ message: `Repository ${org}/${name} already exists` });
      return;
    }
    if (result.status === "no-such-org") {
      reply.code(404).send({ message: "Organization not found - orgs are provisioned explicitly (POST /api/adp/orgs)" });
      return;
    }
    if (result.status === "not-a-member") {
      reply.code(403).send({ message: "Not a member of this organization" });
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
    const repo = await findRepoAuthorized(db, req.identity!, owner, name);
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
