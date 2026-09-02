import { GraphQLError } from "graphql";
import { and, eq, sql } from "drizzle-orm";
import { hasScope } from "../auth/plugin.js";
import { identities, issueComments, issues, proposals, repos, reviews, intents } from "../db/schema.js";
import { findRepoAuthorized, mayAccessOrg } from "../core/repos-lookup.js";
import { recordOperation } from "../core/operations.js";
import type { LandRequirement } from "../core/repo-policy.js";
import { type MergeMethod } from "../core/merge.js";
import { landProposal } from "../core/land.js";
import { renderUnmet } from "../core/land-policy.js";
import { latestGateResults } from "../core/gate-results-lookup.js";
import { emitWebhookEvent } from "../core/webhooks.js";
import { toGlobalId, fromGlobalId } from "./global-id.js";
import { buildConnection, type ConnectionArgs } from "./connections.js";
import type { GqlContext } from "./context.js";
import type { ResolverMap } from "./attach-resolvers.js";
import type { GitBackend } from "../core/git-backend.js";
import type { Signer } from "../core/signing.js";
import { nativeProposalRefusal } from "../core/pull-request-ingest.js";
import { upstreamIngestEnabled } from "../core/mirrors-lookup.js";

type Repo = typeof repos.$inferSelect;
type IssueRow = typeof issues.$inferSelect;
type ProposalRow = typeof proposals.$inferSelect;
type IdentityRow = typeof identities.$inferSelect;
type IssueCommentRow = typeof issueComments.$inferSelect;
type ReviewRow = typeof reviews.$inferSelect;

// GitHub's real SDL distinguishes User (human) from Bot (GitHub App/agent
// actor) via the Actor interface — agent identities (
// §4.4) must resolve as Bot, not User, or `gh`-shaped clients that branch on
// __typename misreport who did what.
function shapeUser(identity: IdentityRow) {
  const __typename = identity.kind === "agent" ? "Bot" : "User";
  return { __typename, id: toGlobalId(__typename, identity.id), login: identity.principal };
}

// Only called from Mutation resolvers, so "requires identity" also means
// "requires the write scope" — mirrors requireScope("repo:write") on the
// REST side (auth/plugin.ts).
function requireIdentity(ctx: GqlContext) {
  if (!ctx.identity) {
    throw new GraphQLError("Requires authentication", { extensions: { code: "UNAUTHORIZED" } });
  }
  if (!hasScope(ctx.identity.scopes, "repo:write")) {
    throw new GraphQLError("Requires scope 'repo:write'", { extensions: { code: "FORBIDDEN" } });
  }
  return ctx.identity;
}

// #91: every by-id load authorizes against the caller's org — mutation
// inputs carry caller-supplied global ids, so "the id decoded" proves
// nothing about the right to touch it. Absent and forbidden are one answer
// (NOT_FOUND), same no-oracle rule as core/repos-lookup.ts.
async function loadRepoById(ctx: GqlContext, repoId: string): Promise<Repo> {
  const [repo] = await ctx.db.select().from(repos).where(eq(repos.id, repoId));
  if (!repo || !ctx.identity || !(await mayAccessOrg(ctx.db, ctx.identity, repo.orgId))) {
    throw new GraphQLError("Repository not found", { extensions: { code: "NOT_FOUND" } });
  }
  return repo;
}

function decodeIdOrThrow(globalId: string, expectedTypeName: string): string {
  const decoded = fromGlobalId(globalId);
  if (!decoded || decoded.typeName !== expectedTypeName) {
    throw new GraphQLError(`Invalid ${expectedTypeName} id`, { extensions: { code: "BAD_USER_INPUT" } });
  }
  return decoded.internalId;
}

async function loadIssueOrThrow(ctx: GqlContext, issueGlobalId: string) {
  const issueId = decodeIdOrThrow(issueGlobalId, "Issue");
  const [issue] = await ctx.db.select().from(issues).where(eq(issues.id, issueId));
  if (!issue) throw new GraphQLError("Issue not found", { extensions: { code: "NOT_FOUND" } });
  const repo = await loadRepoById(ctx, issue.repoId);
  return { issue, repo };
}

async function loadProposalOrThrow(ctx: GqlContext, pullRequestGlobalId: string) {
  const proposalId = decodeIdOrThrow(pullRequestGlobalId, "PullRequest");
  const [proposal] = await ctx.db.select().from(proposals).where(eq(proposals.id, proposalId));
  if (!proposal) throw new GraphQLError("Pull request not found", { extensions: { code: "NOT_FOUND" } });
  const repo = await loadRepoById(ctx, proposal.repoId);
  return { proposal, repo };
}

function shapeIssueComment(comment: IssueCommentRow) {
  return {
    __typename: "IssueComment",
    id: toGlobalId("IssueComment", comment.id),
    body: comment.body,
    createdAt: comment.createdAt.toISOString(),
    __authorId: comment.authorId,
  };
}

const REVIEW_STATE_TO_GRAPHQL: Record<ReviewRow["state"], string> = {
  approved: "APPROVED",
  changes_requested: "CHANGES_REQUESTED",
  commented: "COMMENTED",
};

// PullRequestReviewEvent -> our review state; DISMISS and pending (null,
// no-event) reviews aren't modeled — reviews.state is NOT NULL (schema.ts) —
// so both are cut, matching the rest of the reviews slice's scope.
const REVIEW_EVENT_TO_STATE: Record<string, ReviewRow["state"]> = {
  APPROVE: "approved",
  REQUEST_CHANGES: "changes_requested",
  COMMENT: "commented",
};

const MERGE_METHOD_TO_INTERNAL: Record<string, MergeMethod> = {
  MERGE: "merge",
  SQUASH: "squash",
  REBASE: "rebase",
};

// gate_results.status -> GitHub's StatusState enum. Note `pending` maps to
// PENDING and not EXPECTED: EXPECTED means "a required check that has not
// reported at all", whereas a `pending` gate has reported and is still running.
// gh renders the two differently, and the distinction is the honest one.
const GATE_STATUS_TO_STATUS_STATE: Record<"success" | "failure" | "pending", string> = {
  success: "SUCCESS",
  failure: "FAILURE",
  pending: "PENDING",
};

function shapePullRequestReview(review: ReviewRow) {
  return {
    __typename: "PullRequestReview",
    id: toGlobalId("PullRequestReview", review.id),
    body: review.body,
    state: REVIEW_STATE_TO_GRAPHQL[review.state],
    submittedAt: review.createdAt.toISOString(),
    __authorId: review.reviewerId,
  };
}

function shapeOwner(repo: Repo) {
  // repo.owner is a plain string, not a real identities row — MVP treats it
  // as a login. Good enough for the fields gh actually reads off it.
  return { __typename: "User", id: toGlobalId("User", `owner:${repo.owner}`), login: repo.owner };
}

// Every one of these is a non-null field on the real Repository type — `gh`
// pulls several of them incidentally (e.g. `issue create` checks
// hasIssuesEnabled before doing anything else) even though the MVP has no
// concept of disabling any of these features per repo. All permissive
// defaults; there's nowhere yet to configure them otherwise.
function shapeRepository(repo: Repo) {
  return {
    __typename: "Repository",
    id: toGlobalId("Repository", repo.id),
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: null,
    isPrivate: false,
    isArchived: false,
    isEmpty: false,
    isFork: false,
    isTemplate: false,
    hasIssuesEnabled: true,
    hasProjectsEnabled: true,
    hasWikiEnabled: false,
    hasDiscussionsEnabled: false,
    mergeCommitAllowed: true,
    rebaseMergeAllowed: true,
    squashMergeAllowed: true,
    deleteBranchOnMerge: false,
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
    __issueId: issue.id,
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
    headRefOid: proposal.headSha,
    isDraft: false,
    isCrossRepository: false,
    mergeable: "UNKNOWN",
    mergeStateStatus: "CLEAN",
    isInMergeQueue: false,
    isMergeQueueEnabled: false,
    url: `/${repo.owner}/${repo.name}/pulls/${proposal.number}`,
    createdAt: proposal.createdAt.toISOString(),
    closedAt: proposal.closedAt?.toISOString() ?? null,
    mergedAt: proposal.mergedAt?.toISOString() ?? null,
    __authorId: proposal.authorId,
    __repo: repo,
    __baseRef: proposal.baseRef,
    __headSha: proposal.headSha,
  };
}

// A plain REST-ish shape for outbound webhook payloads (core/webhooks.ts) —
// deliberately not shapePullRequest's GraphQL wrapper (global IDs, __typename,
// __-prefixed loader hints mean nothing to an external subscriber).
function webhookPullRequestPayload(action: "opened" | "closed", proposal: ProposalRow, repo: Repo, merged = false) {
  return {
    action,
    number: proposal.number,
    pull_request: {
      number: proposal.number,
      title: proposal.title,
      body: proposal.body,
      state: proposal.state,
      head: { ref: proposal.headRef, sha: proposal.headSha },
      base: { ref: proposal.baseRef },
      ...(action === "closed" ? { merged } : {}),
    },
    repository: { full_name: `${repo.owner}/${repo.name}` },
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
      __repoId: repo.id,
    },
  };
}

async function resolveAuthor(ctx: GqlContext, authorId: string) {
  const [identity] = await ctx.db.select().from(identities).where(eq(identities.id, authorId));
  return identity ? shapeUser(identity) : null;
}

export function createResolvers(
  gitBackend: GitBackend,
  // Required — same reasoning as proposals.ts's registerProposalRoutes:
  // decrypts webhooks.secretCiphertext before signing outbound deliveries.
  credentialKey: string,
  instanceFloor: LandRequirement[] = [],
  // Optional, same reasoning as proposals.ts's registerProposalRoutes: SBOM
  // per land needs a signer + public URL, kept
  // optional so existing callers/tests that don't care don't need one.
  sbom?: { signer: Signer; publicUrl: string },
): ResolverMap {
  // StatusContext.targetUrl needs an absolute URL. It comes from the same
  // PUBLIC_URL every other absolute-URL producer uses (repos.ts, gates.ts);
  // when a caller supplied no sbom config there is no configured public URL to
  // build from, and a guessed hostname would be worse than none.
  const publicUrl = sbom?.publicUrl ?? null;
  return {
    Query: {
      repository: async (_root, args: { owner: string; name: string }, ctx: GqlContext) => {
        if (!ctx.identity) return null;
        const repo = await findRepoAuthorized(ctx.db, ctx.identity, args.owner, args.name);
        return repo ? shapeRepository(repo) : null;
      },
      viewer: (_root, _args, ctx: GqlContext) => {
        if (!ctx.identity) {
          throw new GraphQLError("Requires authentication", { extensions: { code: "UNAUTHORIZED" } });
        }
        return { __typename: "User", id: toGlobalId("User", ctx.identity.identityId), login: ctx.identity.principal };
      },
      // Global ids are caller-supplied and enumerable in principle, so every
      // branch authorizes the resolved repo's org (#91) — an org-B node is
      // null to an org-A token, exactly as if it did not exist.
      node: async (_root, args: { id: string }, ctx: GqlContext) => {
        const decoded = fromGlobalId(args.id);
        if (!decoded || !ctx.identity) return null;

        const visible = async (repo: Repo | undefined): Promise<Repo | null> =>
          repo && (await mayAccessOrg(ctx.db, ctx.identity!, repo.orgId)) ? repo : null;

        if (decoded.typeName === "Repository") {
          const [row] = await ctx.db.select().from(repos).where(eq(repos.id, decoded.internalId));
          const repo = await visible(row);
          return repo ? shapeRepository(repo) : null;
        }
        if (decoded.typeName === "Issue") {
          const [issue] = await ctx.db.select().from(issues).where(eq(issues.id, decoded.internalId));
          if (!issue) return null;
          const [row] = await ctx.db.select().from(repos).where(eq(repos.id, issue.repoId));
          const repo = await visible(row);
          return repo ? shapeIssue(issue, repo) : null;
        }
        if (decoded.typeName === "PullRequest") {
          const [proposal] = await ctx.db.select().from(proposals).where(eq(proposals.id, decoded.internalId));
          if (!proposal) return null;
          const [row] = await ctx.db.select().from(repos).where(eq(repos.id, proposal.repoId));
          const repo = await visible(row);
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
      // Real GitHub shares one number sequence across issues and PRs, so a
      // given number is unambiguous; ours are separate sequences (schema.ts
      // comment on the proposals table), so `gh issue view`/`gh pr view`
      // both route through this and we just check both tables.
      issueOrPullRequest: async (
        parent: ReturnType<typeof shapeRepository>,
        args: { number: number },
        ctx: GqlContext,
      ) => {
        const [issue] = await ctx.db
          .select()
          .from(issues)
          .where(and(eq(issues.repoId, parent.__repo.id), eq(issues.number, args.number)));
        if (issue) return shapeIssue(issue, parent.__repo);

        const [proposal] = await ctx.db
          .select()
          .from(proposals)
          .where(and(eq(proposals.repoId, parent.__repo.id), eq(proposals.number, args.number)));
        return proposal ? shapePullRequest(proposal, parent.__repo) : null;
      },
    },

    Issue: {
      author: (parent: ReturnType<typeof shapeIssue>, _args, ctx: GqlContext) =>
        resolveAuthor(ctx, parent.__authorId),
      // Assignees/labels/milestone aren't modeled at all yet (no schema.ts
      // tables) — empty/null is the honest answer, and satisfies the
      // non-null connection types `gh` expects to always get back something.
      assignees: () => buildConnection([], {}),
      labels: () => buildConnection([], {}),
      milestone: () => null,
      reactionGroups: () => [],
      projectCards: () => buildConnection([], {}),
      comments: async (parent: ReturnType<typeof shapeIssue>, args: ConnectionArgs, ctx: GqlContext) => {
        const rows = await ctx.db.select().from(issueComments).where(eq(issueComments.issueId, parent.__issueId));
        return buildConnection(rows.map(shapeIssueComment), args);
      },
    },

    PullRequest: {
      author: (parent: ReturnType<typeof shapePullRequest>, _args, ctx: GqlContext) =>
        resolveAuthor(ctx, parent.__authorId),
      assignees: () => buildConnection([], {}),
      labels: () => buildConnection([], {}),
      milestone: () => null,
      reactionGroups: () => [],
      projectCards: () => buildConnection([], {}),
      // PR conversation-tab comments aren't modeled separately from issue
      // comments (same gap as Mutation.addComment) — empty, not an error.
      comments: () => buildConnection([], {}),
      maintainerCanModify: () => true,
      additions: async (parent: ReturnType<typeof shapePullRequest>) =>
        (await gitBackend.diffStat(parent.__repo.owner, parent.__repo.name, parent.__baseRef, parent.__headSha))
          .additions,
      deletions: async (parent: ReturnType<typeof shapePullRequest>) =>
        (await gitBackend.diffStat(parent.__repo.owner, parent.__repo.name, parent.__baseRef, parent.__headSha))
          .deletions,
      changedFiles: async (parent: ReturnType<typeof shapePullRequest>) =>
        (await gitBackend.diffStat(parent.__repo.owner, parent.__repo.name, parent.__baseRef, parent.__headSha))
          .changedFiles,
      commits: async (parent: ReturnType<typeof shapePullRequest>, args: ConnectionArgs) => {
        const commits = await gitBackend.log(
          parent.__repo.owner,
          parent.__repo.name,
          `${parent.__baseRef}..${parent.__headSha}`,
          250,
        );
        const nodes = commits.reverse().map((c) => ({
          __typename: "PullRequestCommit",
          id: toGlobalId("PullRequestCommit", `${parent.__headSha}:${c.sha}`),
          commit: {
            __typename: "Commit",
            id: toGlobalId("Commit", c.sha),
            oid: c.sha,
            message: c.message,
            committedDate: c.authorDate,
            __repoId: parent.__repo.id,
          },
        }));
        return buildConnection(nodes, args);
      },
    },

    IssueComment: {
      author: (parent: ReturnType<typeof shapeIssueComment>, _args, ctx: GqlContext) =>
        resolveAuthor(ctx, parent.__authorId),
    },

    // Evidence bundles (core/dsse.ts, core/gate-results-lookup.ts) projected
    // onto the compat plane. Returns null entirely
    // (StatusCheckRollup is a nullable field) when nothing has been reported
    // for this commit, same as a repo with no CI configured at all on real
    // GitHub.
    Commit: {
      statusCheckRollup: async (parent: { oid: string; __repoId?: string }, _args, ctx: GqlContext) => {
        if (!parent.__repoId) return null;
        const latest = await latestGateResults(ctx.db, parent.__repoId, parent.oid);
        if (latest.size === 0) return null;

        const statuses = [...latest.values()].map((r) => r.status);
        const state = statuses.includes("failure")
          ? "FAILURE"
          : statuses.includes("pending")
            ? "PENDING"
            : "SUCCESS";

        return {
          __typename: "StatusCheckRollup",
          id: toGlobalId("StatusCheckRollup", `${parent.__repoId}:${parent.oid}`),
          state,
          __repoId: parent.__repoId,
          __oid: parent.oid,
        };
      },
    },

    // `contexts` is what `gh pr checks` actually enumerates — the aggregate
    // `state` above was already real, but an empty connection here made gh
    // report "no checks reported" and exit nonzero on a green rollup. That was
    // the last §2.1 gap: an agent that cannot see why its own CI passed or
    // failed is exactly the hole the evidence plane exists to close.
    //
    // Each gate result projects to a StatusContext rather than a CheckRun. A
    // CheckRun belongs to a CheckSuite belongs to a WorkflowRun — an Actions
    // execution model ADP deliberately does not have (§2.5) — so claiming that
    // shape would be a lie about what produced the result. StatusContext is the
    // honest mapping: an external system reported a named status against a
    // commit, which is precisely what a gate is.
    StatusCheckRollup: {
      contexts: async (parent: { __repoId: string; __oid: string }, args: ConnectionArgs, ctx: GqlContext) => {
        const latest = await latestGateResults(ctx.db, parent.__repoId, parent.__oid);
        const repo = await loadRepoById(ctx, parent.__repoId);

        const items = [...latest.values()]
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .map((row) => ({
            __typename: "StatusContext" as const,
            id: toGlobalId("StatusContext", `${parent.__repoId}:${parent.__oid}:${row.name}`),
            context: row.name,
            state: GATE_STATUS_TO_STATUS_STATE[row.status],
            description: row.summary,
            // Points at the evidence bundle, which is where the DSSE envelope
            // behind this verdict actually lives — the one link an agent
            // following up on a red gate wants. Null rather than a guessed
            // hostname when the deployment did not configure a public URL.
            targetUrl: publicUrl
              ? `${publicUrl.replace(/\/$/, "")}/api/adp/repos/${repo.owner}/${repo.name}/evidence/${parent.__oid}`
              : null,
            createdAt: row.createdAt.toISOString(),
            avatarUrl: null,
            creator: null,
            // Land policy decides what is required, and it does so per repo
            // from adp.yaml rather than per context here. Reporting `true`
            // would tell gh a gate blocks merging when the repo may not
            // require it at all.
            isRequired: false,
          }));

        const counts = new Map<string, number>();
        for (const item of items) counts.set(item.state, (counts.get(item.state) ?? 0) + 1);

        return {
          ...buildConnection(items, args),
          // Every context is a StatusContext, never a CheckRun — see above.
          checkRunCount: 0,
          checkRunCountsByState: [],
          statusContextCount: items.length,
          statusContextCountsByState: [...counts].map(([state, count]) => ({ state, count })),
        };
      },
    },

    PullRequestReview: {
      author: (parent: ReturnType<typeof shapePullRequestReview>, _args, ctx: GqlContext) =>
        resolveAuthor(ctx, parent.__authorId),
    },

    Mutation: {
      createIssue: async (
        _root,
        args: { input: { repositoryId: string; title: string; body?: string | null } },
        ctx: GqlContext,
      ) => {
        const identity = requireIdentity(ctx);
        const repo = await loadRepoById(ctx, decodeIdOrThrow(args.input.repositoryId, "Repository"));
        const title = args.input.title;
        const body = args.input.body ?? "";

        const issue = await ctx.db.transaction(async (tx) => {
          await tx.execute(sql`select id from repos where id = ${repo.id} for update`);
          const [row] = await tx
            .select({ nextNumber: sql<number>`coalesce(max(${issues.number}), 0) + 1` })
            .from(issues)
            .where(eq(issues.repoId, repo.id));
          const nextNumber = row!.nextNumber;

          const [intent] = await tx
            .insert(intents)
            .values({ repoId: repo.id, title, body, source: "api" })
            .returning();

          const [created] = await tx
            .insert(issues)
            .values({
              repoId: repo.id,
              number: nextNumber,
              title,
              body,
              authorId: identity.identityId,
              intentId: intent!.id,
            })
            .returning();

          await recordOperation(tx, {
            repoId: repo.id,
            actorId: identity.identityId,
            verb: "issue.create",
            target: `${repo.owner}/${repo.name}#${nextNumber}`,
            after: { id: created!.id, title, state: "open" },
          });

          return created!;
        });

        return { clientMutationId: null, issue: shapeIssue(issue, repo) };
      },

      closeIssue: async (_root, args: { input: { issueId: string } }, ctx: GqlContext) => {
        const identity = requireIdentity(ctx);
        const { issue: existing, repo } = await loadIssueOrThrow(ctx, args.input.issueId);

        const updated = await ctx.db.transaction(async (tx) => {
          const [updated] = await tx
            .update(issues)
            .set({ state: "closed", closedAt: new Date() })
            .where(eq(issues.id, existing.id))
            .returning();

          await recordOperation(tx, {
            repoId: repo.id,
            actorId: identity.identityId,
            verb: "issue.close",
            target: `${repo.owner}/${repo.name}#${existing.number}`,
            before: { state: existing.state },
            after: { state: "closed" },
          });

          return updated!;
        });

        return { clientMutationId: null, issue: shapeIssue(updated, repo) };
      },

      addComment: async (
        _root,
        args: { input: { subjectId: string; body: string } },
        ctx: GqlContext,
      ) => {
        const identity = requireIdentity(ctx);
        const decoded = fromGlobalId(args.input.subjectId);
        if (!decoded || decoded.typeName !== "Issue") {
          // PR conversation-tab comments aren't modeled separately from issue
          // comments yet (no proposals<->issue_comments link in schema.ts) —
          // cut for this slice; `gh issue comment` is the supported path.
          throw new GraphQLError("addComment only supports Issue subjects in this MVP", {
            extensions: { code: "BAD_USER_INPUT" },
          });
        }
        const { issue, repo } = await loadIssueOrThrow(ctx, args.input.subjectId);

        const comment = await ctx.db.transaction(async (tx) => {
          const [comment] = await tx
            .insert(issueComments)
            .values({ issueId: issue.id, authorId: identity.identityId, body: args.input.body })
            .returning();

          await recordOperation(tx, {
            repoId: repo.id,
            actorId: identity.identityId,
            verb: "issue.comment.create",
            target: `${repo.owner}/${repo.name}#${issue.number}`,
            after: { id: comment!.id },
          });

          return comment!;
        });

        const node = shapeIssueComment(comment);
        return {
          clientMutationId: null,
          subject: shapeIssue(issue, repo),
          commentEdge: { cursor: toGlobalId("IssueComment", comment.id), node },
          timelineEdge: null,
        };
      },

      createPullRequest: async (
        _root,
        args: {
          input: {
            repositoryId: string;
            title: string;
            body?: string | null;
            baseRefName: string;
            headRefName: string;
          };
        },
        ctx: GqlContext,
      ) => {
        const identity = requireIdentity(ctx);
        const repo = await loadRepoById(ctx, decodeIdOrThrow(args.input.repositoryId, "Repository"));
        const { title, baseRefName, headRefName } = args.input;
        const body = args.input.body ?? "";

        // The same refusal the REST create path gives, on the same grounds
        // (#224). It has to be on both: `gh pr create` goes through GraphQL,
        // so a guard only on /api/v3 would be a guard the incumbent client
        // walks straight past.
        if (await upstreamIngestEnabled(ctx.db, repo.id)) {
          const refusal = nativeProposalRefusal(repo.owner, repo.name);
          throw new GraphQLError(`${refusal.message} — ${refusal.remedy}`, {
            extensions: { code: "FORBIDDEN", reason: refusal.reason },
          });
        }

        const headSha = await gitBackend.resolveRef(repo.owner, repo.name, headRefName);
        if (!headSha) {
          throw new GraphQLError(`head branch '${headRefName}' not found`, {
            extensions: { code: "BAD_USER_INPUT" },
          });
        }
        const baseSha = await gitBackend.resolveRef(repo.owner, repo.name, baseRefName);
        if (!baseSha) {
          throw new GraphQLError(`base branch '${baseRefName}' not found`, {
            extensions: { code: "BAD_USER_INPUT" },
          });
        }

        const proposal = await ctx.db.transaction(async (tx) => {
          await tx.execute(sql`select id from repos where id = ${repo.id} for update`);
          const [row] = await tx
            .select({ nextNumber: sql<number>`coalesce(max(${proposals.number}), 0) + 1` })
            .from(proposals)
            .where(eq(proposals.repoId, repo.id));
          const nextNumber = row!.nextNumber;

          const [created] = await tx
            .insert(proposals)
            .values({
              repoId: repo.id,
              number: nextNumber,
              title,
              body,
              headRef: headRefName,
              headSha,
              baseRef: baseRefName,
              authorId: identity.identityId,
            })
            .returning();

          await recordOperation(tx, {
            repoId: repo.id,
            actorId: identity.identityId,
            verb: "proposal.create",
            target: `${repo.owner}/${repo.name}#${nextNumber}`,
            after: { id: created!.id, head: headRefName, base: baseRefName, headSha },
          });

          return created!;
        });

        emitWebhookEvent(
          ctx.db,
          repo.id,
          "pull_request",
          webhookPullRequestPayload("opened", proposal, repo),
          ctx.log,
          credentialKey,
        );

        return { clientMutationId: null, pullRequest: shapePullRequest(proposal, repo) };
      },

      closePullRequest: async (_root, args: { input: { pullRequestId: string } }, ctx: GqlContext) => {
        const identity = requireIdentity(ctx);
        const { proposal: existing, repo } = await loadProposalOrThrow(ctx, args.input.pullRequestId);
        if (existing.state === "merged") {
          throw new GraphQLError("Cannot close a merged pull request", { extensions: { code: "BAD_USER_INPUT" } });
        }

        const updated = await ctx.db.transaction(async (tx) => {
          const [updated] = await tx
            .update(proposals)
            .set({ state: "closed", closedAt: new Date() })
            .where(eq(proposals.id, existing.id))
            .returning();

          await recordOperation(tx, {
            repoId: repo.id,
            actorId: identity.identityId,
            verb: "proposal.close",
            target: `${repo.owner}/${repo.name}#${existing.number}`,
            before: { state: existing.state },
            after: { state: "closed" },
          });

          return updated!;
        });

        return { clientMutationId: null, pullRequest: shapePullRequest(updated, repo) };
      },

      reopenPullRequest: async (_root, args: { input: { pullRequestId: string } }, ctx: GqlContext) => {
        const identity = requireIdentity(ctx);
        const { proposal: existing, repo } = await loadProposalOrThrow(ctx, args.input.pullRequestId);
        if (existing.state === "merged") {
          throw new GraphQLError("Cannot reopen a merged pull request", { extensions: { code: "BAD_USER_INPUT" } });
        }

        const updated = await ctx.db.transaction(async (tx) => {
          const [updated] = await tx
            .update(proposals)
            .set({ state: "open", closedAt: null })
            .where(eq(proposals.id, existing.id))
            .returning();

          await recordOperation(tx, {
            repoId: repo.id,
            actorId: identity.identityId,
            verb: "proposal.reopen",
            target: `${repo.owner}/${repo.name}#${existing.number}`,
            before: { state: existing.state },
            after: { state: "open" },
          });

          return updated!;
        });

        return { clientMutationId: null, pullRequest: shapePullRequest(updated, repo) };
      },

      // proposals has no draft column (see schema.ts) — every PR is already
      // "ready for review" the moment it's created, so this is a recorded
      // no-op rather than a state transition. Keeps the op log honest about
      // what `gh pr ready` actually did against this server.
      markPullRequestReadyForReview: async (
        _root,
        args: { input: { pullRequestId: string } },
        ctx: GqlContext,
      ) => {
        const identity = requireIdentity(ctx);
        const { proposal, repo } = await loadProposalOrThrow(ctx, args.input.pullRequestId);

        await ctx.db.transaction(async (tx) => {
          await recordOperation(tx, {
            repoId: repo.id,
            actorId: identity.identityId,
            verb: "proposal.ready_for_review",
            target: `${repo.owner}/${repo.name}#${proposal.number}`,
            before: { isDraft: false },
            after: { isDraft: false },
          });
        });

        return { clientMutationId: null, pullRequest: shapePullRequest(proposal, repo) };
      },

      // Same land model as REST (proposals.ts) — see that file's comment for
      // why 409-and-rebase is the MVP's whole conflict story, and
      // core/merge.ts for what merge_method changes about the result.
      mergePullRequest: async (
        _root,
        args: {
          input: { pullRequestId: string; expectedHeadOid?: string | null; mergeMethod?: string | null };
        },
        ctx: GqlContext,
      ) => {
        const identity = requireIdentity(ctx);
        const { proposal, repo } = await loadProposalOrThrow(ctx, args.input.pullRequestId);

        if (proposal.state === "merged") {
          throw new GraphQLError("Already merged", { extensions: { code: "BAD_USER_INPUT" } });
        }
        if (proposal.state === "closed") {
          throw new GraphQLError("Cannot merge a closed pull request", { extensions: { code: "BAD_USER_INPUT" } });
        }
        if (args.input.expectedHeadOid && args.input.expectedHeadOid !== proposal.headSha) {
          throw new GraphQLError("Head ref oid does not match expectedHeadOid", {
            extensions: { code: "CONFLICT" },
          });
        }

        const mergeMethod = MERGE_METHOD_TO_INTERNAL[args.input.mergeMethod ?? "MERGE"] ?? "merge";
        // The land sequence itself — policy, fast-forward precondition, the
        // TOCTOU re-check at the CAS point, the merge, and the post-merge
        // bookkeeping — is core/land.ts, shared with the REST merge route and
        // with candidate-set resolution. Only the error shaping and the
        // webhook payload are GraphQL's own.
        const result = await landProposal(
          {
            db: ctx.db,
            gitBackend,
            instanceFloor,
            sbom,
            logError: (message: string, err: unknown) => console.error(`${message}:`, err),
          },
          repo,
          proposal,
          mergeMethod,
          { identityId: identity.identityId, principal: identity.principal },
        );
        if (!result.ok) {
          // #145: one line per unmet requirement, each carrying its own
          // remedy. This message is what `gh pr merge` prints, which is where
          // most people will actually read a refusal — so the remedy has to
          // survive the projection rather than living only in the REST body.
          throw new GraphQLError(
            result.unmet
              ? ["Land policy not satisfied:", ...result.unmet.map((u) => `  ${renderUnmet(u)}`)].join("\n")
              : result.message,
            { extensions: { code: result.status === 409 ? "CONFLICT" : "BAD_USER_INPUT" } },
          );
        }
        const merged = result.proposal;

        emitWebhookEvent(
          ctx.db,
          repo.id,
          "pull_request",
          webhookPullRequestPayload("closed", merged, repo, true),
          ctx.log,
          credentialKey,
        );

        return {
          clientMutationId: null,
          actor: shapeUser(await mustLoadIdentity(ctx, identity.identityId)),
          pullRequest: shapePullRequest(merged, repo),
        };
      },

      addPullRequestReview: async (
        _root,
        args: {
          input: {
            pullRequestId: string;
            body?: string | null;
            event?: string | null;
          };
        },
        ctx: GqlContext,
      ) => {
        const identity = requireIdentity(ctx);
        const { proposal, repo } = await loadProposalOrThrow(ctx, args.input.pullRequestId);
        const state = REVIEW_EVENT_TO_STATE[args.input.event ?? "COMMENT"];
        if (!state) {
          throw new GraphQLError(`Unsupported review event '${args.input.event}'`, {
            extensions: { code: "BAD_USER_INPUT" },
          });
        }

        const review = await ctx.db.transaction(async (tx) => {
          const [review] = await tx
            .insert(reviews)
            .values({
              proposalId: proposal.id,
              reviewerId: identity.identityId,
              state,
              body: args.input.body ?? "",
            })
            .returning();

          await recordOperation(tx, {
            repoId: repo.id,
            actorId: identity.identityId,
            verb: "review.create",
            target: `${repo.owner}/${repo.name}#${proposal.number}`,
            after: { id: review!.id, state },
          });

          return review!;
        });

        const node = shapePullRequestReview(review);
        return {
          clientMutationId: null,
          pullRequestReview: node,
          reviewEdge: { cursor: toGlobalId("PullRequestReview", review.id), node },
        };
      },
    },
  };
}

async function mustLoadIdentity(ctx: GqlContext, identityId: string): Promise<IdentityRow> {
  const [identity] = await ctx.db.select().from(identities).where(eq(identities.id, identityId));
  if (!identity) throw new GraphQLError("Actor identity not found", { extensions: { code: "NOT_FOUND" } });
  return identity;
}
