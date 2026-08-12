import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, count, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "../core/git-backend.js";
import { orgs, repos, workspaces, gateJobs } from "../db/schema.js";
import { requireScope, requireOrgAccess } from "../auth/plugin.js";
import { recordOperation } from "../core/operations.js";
import { isOrgMember } from "../auth/tokens.js";
import { describeOrgPolicy } from "../core/org-policy.js";
import { loadRepoPolicy, resolveLandRequirements, type LandRequirement } from "../core/repo-policy.js";

// M4-7 — the org policy console (docs/m4-readiness-review.md §4).
//
// The review calls this item "UI work over an existing API". That was true of
// the plane it names (M4-2 built resolution) and not of the API: the only
// org-scoped route that existed was the audit-log export, and M4-2's own code
// says so — "no REST route to set repos.orgId / orgs.killSwitch /
// orgs.policyRepoId yet ... org management is M4-7's job". So the console
// needed an API to be a console over, and this file is it.
//
// What it deliberately does NOT do is let anyone edit an org's floor here.
// M4-2's design is that policy changes travel the same intent → diff →
// evidence → provenance path as code, because the floor *is* a file in a repo
// that gets proposed, reviewed and landed. A "save policy" button would be a
// second, unsigned way to change the same thing, and the weaker one would win
// every time it was more convenient. The console shows what is in force and
// where each requirement came from; changing it means landing a change to
// policy.yaml.
//
// The one exception is the kill switch, and it is an exception for a reason:
// it is a row column, not a file, it is the lever an operator reaches for
// while something is actively going wrong, and until this route existed there
// was no way to pull it at all short of `psql`. A switch that can only be
// thrown by hand-writing SQL against production is not a shipped safety
// feature.

const PatchOrgBody = z.object({
  kill_switch: z.boolean(),
});

const OrgReposQuery = z.object({
  // Each repo in the response costs two git reads (statPath + readBlob for
  // adp.yaml), so this is bounded by default rather than "every repo in the
  // org, however many that is".
  limit: z.coerce.number().int().positive().max(200).default(50),
});

interface QuotaView {
  limit: number | null;
  used: number;
}

async function usage(db: Db, orgId: string): Promise<{
  repos: QuotaView["used"];
  workspaces: QuotaView["used"];
  gateJobs: QuotaView["used"];
}> {
  // Each count mirrors exactly the query the corresponding enforcement path
  // runs — repos: http-rest/repos.ts, live workspaces: core/workspaces.ts,
  // running gate jobs: core/gate-jobs.ts's claim. A console that computed
  // "used" its own way would eventually disagree with the thing doing the
  // refusing, and the operator would believe the console.
  const [repoRow] = await db.select({ n: count() }).from(repos).where(eq(repos.orgId, orgId));
  const [workspaceRow] = await db
    .select({ n: count() })
    .from(workspaces)
    .innerJoin(repos, eq(workspaces.repoId, repos.id))
    .where(and(eq(repos.orgId, orgId), isNull(workspaces.destroyedAt)));
  const [gateJobRow] = await db
    .select({ n: count() })
    .from(gateJobs)
    .innerJoin(repos, eq(gateJobs.repoId, repos.id))
    .where(and(eq(repos.orgId, orgId), eq(gateJobs.status, "running")));

  return {
    repos: repoRow?.n ?? 0,
    workspaces: workspaceRow?.n ?? 0,
    gateJobs: gateJobRow?.n ?? 0,
  };
}

async function policyRepoFor(db: Db, policyRepoId: string | null) {
  if (!policyRepoId) return null;
  const [row] = await db.select().from(repos).where(eq(repos.id, policyRepoId));
  if (!row) return null;
  return { owner: row.owner, name: row.name, defaultBranch: row.defaultBranch };
}

export function registerOrgRoutes(
  app: FastifyInstance,
  db: Db,
  gitBackend: GitBackend,
  instanceFloor: LandRequirement[],
) {
  // Which org this token can look at. Returns at most one: `requireOrgAccess`
  // (M4-1) grants access only where the *token* is scoped to the org, so a
  // human who belongs to three orgs still sees one per token — the token
  // carries the grant, not the person. Returning the orgs they are a member
  // of regardless would be a list of things every other route then 403s on,
  // which reads as a bug rather than as a security boundary.
  app.get("/api/adp/orgs", { preHandler: requireScope("repo:read") }, async (req, reply) => {
    const identity = req.identity!;
    if (!identity.orgId || !(await isOrgMember(db, identity.orgId, identity.identityId))) {
      reply.send([]);
      return;
    }

    const [org] = await db.select().from(orgs).where(eq(orgs.id, identity.orgId));
    if (!org) {
      reply.send([]);
      return;
    }

    reply.send([{ id: org.id, name: org.name, kill_switch: org.killSwitch }]);
  });

  app.get(
    "/api/adp/orgs/:orgId",
    { preHandler: [requireScope("repo:read"), requireOrgAccess(db, "orgId")] },
    async (req, reply) => {
      const { orgId } = req.params as { orgId: string };
      const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
      if (!org) {
        reply.code(404).send({ message: `Organization ${orgId} not found` });
        return;
      }

      const policyRepo = await policyRepoFor(db, org.policyRepoId);
      const { policy, source } = await describeOrgPolicy(gitBackend, policyRepo);
      const counts = await usage(db, orgId);

      reply.send({
        id: org.id,
        name: org.name,
        kill_switch: org.killSwitch,
        policy_repo: policyRepo
          ? { owner: policyRepo.owner, name: policyRepo.name, default_branch: policyRepo.defaultBranch }
          : null,
        // `source` is what stops a fail-closed floor from being read as a
        // deliberate one — see core/org-policy.ts.
        org_floor: { require: policy.land.require, source },
        instance_floor: instanceFloor,
        quotas: {
          max_repos: { limit: org.maxRepos, used: counts.repos },
          max_concurrent_workspaces: { limit: org.maxConcurrentWorkspaces, used: counts.workspaces },
          max_concurrent_gate_jobs: { limit: org.maxConcurrentGateJobs, used: counts.gateJobs },
        },
      });
    },
  );

  // The view the console exists for: for every repo in the org, what land
  // policy actually resolves to right now, and which of the three layers put
  // each requirement there. Today that answer is only obtainable by reading a
  // YAML file out of two different repos and knowing how the union works.
  app.get(
    "/api/adp/orgs/:orgId/repos",
    { preHandler: [requireScope("repo:read"), requireOrgAccess(db, "orgId")] },
    async (req, reply) => {
      const { orgId } = req.params as { orgId: string };
      const parsed = OrgReposQuery.safeParse(req.query);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
        return;
      }

      const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
      if (!org) {
        reply.code(404).send({ message: `Organization ${orgId} not found` });
        return;
      }

      const policyRepo = await policyRepoFor(db, org.policyRepoId);
      const { policy: orgPolicy } = await describeOrgPolicy(gitBackend, policyRepo);
      const orgFloor = orgPolicy.land.require;

      const rows = await db
        .select()
        .from(repos)
        .where(eq(repos.orgId, orgId))
        .orderBy(repos.owner, repos.name)
        .limit(parsed.data.limit);

      const items = [];
      for (const repo of rows) {
        const repoPolicy = await loadRepoPolicy(gitBackend, repo.owner, repo.name, repo.defaultBranch);
        const resolved = resolveLandRequirements(instanceFloor, orgFloor, repoPolicy);

        items.push({
          id: repo.id,
          owner: repo.owner,
          name: repo.name,
          default_branch: repo.defaultBranch,
          is_policy_repo: repo.id === org.policyRepoId,
          repo_requirements: repoPolicy.land.require,
          // Per requirement, every layer that asks for it. A requirement
          // named by the instance floor cannot be removed by an org or a
          // repo, and this is where that stops being a claim in a doc and
          // becomes visible: the operator can see which layer they would have
          // to change, or that they cannot change it at all.
          resolved: resolved.map((requirement) => ({
            requirement,
            from: [
              ...(instanceFloor.includes(requirement) ? ["instance"] : []),
              ...(orgFloor.includes(requirement) ? ["org"] : []),
              ...(repoPolicy.land.require.includes(requirement) ? ["repo"] : []),
            ],
          })),
        });
      }

      reply.send(items);
    },
  );

  // `admin`, not `repo:write`: this refuses every land in the org, which is
  // not something the ability to push code should carry with it.
  app.patch(
    "/api/adp/orgs/:orgId",
    { preHandler: [requireScope("admin"), requireOrgAccess(db, "orgId")] },
    async (req, reply) => {
      const { orgId } = req.params as { orgId: string };
      const parsed = PatchOrgBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: parsed.error.issues });
        return;
      }

      const [existing] = await db.select().from(orgs).where(eq(orgs.id, orgId));
      if (!existing) {
        reply.code(404).send({ message: `Organization ${orgId} not found` });
        return;
      }

      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(orgs)
          .set({ killSwitch: parsed.data.kill_switch })
          .where(eq(orgs.id, orgId))
          .returning();

        // CLAUDE.md's standing invariant — the operation log is written in the
        // same transaction as the change. `repoId` is null because this change
        // is not about one repo; it is about every repo in the org at once,
        // which is exactly what makes it worth recording. core/operations.ts
        // anticipated this case ("pass null explicitly for the currently
        // nonexistent genuinely global verb"); this is the first one.
        await recordOperation(tx, {
          repoId: null,
          actorId: req.identity!.identityId,
          verb: "org.kill_switch",
          target: existing.name,
          before: { kill_switch: existing.killSwitch },
          after: { kill_switch: row!.killSwitch },
        });

        return row!;
      });

      reply.send({ id: updated.id, name: updated.name, kill_switch: updated.killSwitch });
    },
  );
}
