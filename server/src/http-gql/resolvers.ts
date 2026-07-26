import { GraphQLError } from "graphql";
import { and, eq } from "drizzle-orm";
import { identities, issues, proposals, repos } from "../db/schema.js";
import { findRepo } from "../core/repos-lookup.js";
import { toGlobalId, fromGlobalId } from "./global-id.js";
import { buildConnection, type ConnectionArgs } from "./connections.js";
import type { GqlContext } from "./context.js";
import type { ResolverMap } from "./attach-resolvers.js";
import type { GitBackend } from "../core/git-backend.js";

type Repo = typeof repos.$inferSelect;
type IssueRow = typeof issues.$inferSelect;
type ProposalRow = typeof proposals.$inferSelect;
type IdentityRow = typeof identities.$inferSelect;

function shapeUser(identity: IdentityRow) {
  return { __typename: "User", id: toGlobalId("User", identity.id), login: identity.principal };
}

function shapeOwner(repo: Repo) {
  // repo.owner is a plain string, not a real identities row — MVP treats it
  // as a login. Good enough for the fields gh actually reads off it.
  return { __typename: "User", id: toGlobalId("User", `owner:${repo.owner}`), login: repo.owner };
}

function shapeRepository(repo: Repo) {
  return {
    __typename: "Repository",
    id: toGlobalId("Repository", repo.id),
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: null,
    isPrivate: false,
    url: `/${repo.owner}/${repo.name}`,
    viewerPermission: "WRITE",
    __repo: repo,
  };
}

function shapeIssue(issue: IssueRow, repo: Repo) {
  return {
    __typename: "Issue",
    id: toGlobalId("Issue", issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === "closed" ? "CLOSED" : "OPEN",
    url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: issue.createdAt.toISOString(),
    closedAt: issue.closedAt?.toISOString() ?? null,
    __authorId: issue.authorId,
  };
}

function shapePullRequest(proposal: ProposalRow, repo: Repo) {
  const state = proposal.state === "merged" ? "MERGED" : proposal.state === "closed" ? "CLOSED" : "OPEN";
  return {
    __typename: "PullRequest",
    id: toGlobalId("PullRequest", proposal.id),
    number: proposal.number,
    title: proposal.title,
    body: proposal.body,
    state,
    baseRefName: proposal.baseRef,
    headRefName: proposal.headRef,
    isDraft: false,
    mergeable: "UNKNOWN",
    url: `/${repo.owner}/${repo.name}/pulls/${proposal.number}`,
    createdAt: proposal.createdAt.toISOString(),
    closedAt: proposal.closedAt?.toISOString() ?? null,
    mergedAt: proposal.mergedAt?.toISOString() ?? null,
    __authorId: proposal.authorId,
  };
}

async function shapeRef(db: GqlContext["db"], gitBackend: GitBackend, repo: Repo, branch: string) {
  const sha = await gitBackend.resolveRef(repo.owner, repo.name, branch);
  if (!sha) return null;
  return {
    __typename: "Ref",
    id: toGlobalId("Ref", `${repo.owner}/${repo.name}/${branch}`),
    name: branch,
    target: {
      __typename: "Commit",
      id: toGlobalId("Commit", sha),
      oid: sha,
    },
  };
}

async function resolveAuthor(ctx: GqlContext, authorId: string) {
  const [identity] = await ctx.db.select().from(identities).where(eq(identities.id, authorId));
  return identity ? shapeUser(identity) : null;
}

export function createResolvers(gitBackend: GitBackend): ResolverMap {
  return {
    Query: {
      repository: async (_root, args: { owner: string; name: string }, ctx: GqlContext) => {
        const repo = await findRepo(ctx.db, args.owner, args.name);
        return repo ? shapeRepository(repo) : null;
      },
      viewer: (_root, _args, ctx: GqlContext) => {
        if (!ctx.identity) {
          throw new GraphQLError("Requires authentication", { extensions: { code: "UNAUTHORIZED" } });
        }
        return { __typename: "User", id: toGlobalId("User", ctx.identity.identityId), login: ctx.identity.principal };
      },
      node: async (_root, args: { id: string }, ctx: GqlContext) => {
        const decoded = fromGlobalId(args.id);
        if (!decoded) return null;

        if (decoded.typeName === "Repository") {
          const [repo] = await ctx.db.select().from(repos).where(eq(repos.id, decoded.internalId));
          return repo ? shapeRepository(repo) : null;
        }
        if (decoded.typeName === "Issue") {
          const [issue] = await ctx.db.select().from(issues).where(eq(issues.id, decoded.internalId));
          if (!issue) return null;
          const [repo] = await ctx.db.select().from(repos).where(eq(repos.id, issue.repoId));
          return repo ? shapeIssue(issue, repo) : null;
        }
        if (decoded.typeName === "PullRequest") {
          const [proposal] = await ctx.db.select().from(proposals).where(eq(proposals.id, decoded.internalId));
          if (!proposal) return null;
          const [repo] = await ctx.db.select().from(repos).where(eq(repos.id, proposal.repoId));
          return repo ? shapePullRequest(proposal, repo) : null;
        }
        return null;
      },
    },

    Repository: {
      owner: (parent: ReturnType<typeof shapeRepository>) => shapeOwner(parent.__repo),
      defaultBranchRef: (parent: ReturnType<typeof shapeRepository>, _args, ctx: GqlContext) =>
        shapeRef(ctx.db, gitBackend, parent.__repo, parent.__repo.defaultBranch),
      issue: async (parent: ReturnType<typeof shapeRepository>, args: { number: number }, ctx: GqlContext) => {
        const [issue] = await ctx.db
          .select()
          .from(issues)
          .where(and(eq(issues.repoId, parent.__repo.id), eq(issues.number, args.number)));
        return issue ? shapeIssue(issue, parent.__repo) : null;
      },
      issues: async (parent: ReturnType<typeof shapeRepository>, args: ConnectionArgs, ctx: GqlContext) => {
        const rows = await ctx.db.select().from(issues).where(eq(issues.repoId, parent.__repo.id));
        return buildConnection(
          rows.map((row) => shapeIssue(row, parent.__repo)),
          args,
        );
      },
      pullRequest: async (parent: ReturnType<typeof shapeRepository>, args: { number: number }, ctx: GqlContext) => {
        const [proposal] = await ctx.db
          .select()
          .from(proposals)
          .where(and(eq(proposals.repoId, parent.__repo.id), eq(proposals.number, args.number)));
        return proposal ? shapePullRequest(proposal, parent.__repo) : null;
      },
      pullRequests: async (parent: ReturnType<typeof shapeRepository>, args: ConnectionArgs, ctx: GqlContext) => {
        const rows = await ctx.db.select().from(proposals).where(eq(proposals.repoId, parent.__repo.id));
        return buildConnection(
          rows.map((row) => shapePullRequest(row, parent.__repo)),
          args,
        );
      },
    },

    Issue: {
      author: (parent: ReturnType<typeof shapeIssue>, _args, ctx: GqlContext) =>
        resolveAuthor(ctx, parent.__authorId),
    },

    PullRequest: {
      author: (parent: ReturnType<typeof shapePullRequest>, _args, ctx: GqlContext) =>
        resolveAuthor(ctx, parent.__authorId),
    },
  };
}
