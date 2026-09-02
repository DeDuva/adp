import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "./git-backend.js";
import { mirrorSyncLog, operations, proposals } from "../db/schema.js";
import { recordOperation } from "./operations.js";

// Ingest for a mirrored repo's upstream pull requests — the object companion
// mode was missing.
//
// Mirror inbound already carried the two facts GitHub emits about *code*: the
// commits (`push`) and the CI verdicts (`workflow_run`). What it carried none
// of was the fact that says what any of it was for. `evaluateLandPolicy`,
// `undo` and the evidence bundle are each written against a proposal, so a
// repository whose pull requests live on GitHub could not reach any of them.
//
// A shadow proposal is an ordinary `proposals` row. That is the whole design:
// a parallel "external pull request" type would mean reimplementing policy
// evaluation, the check runs and undo against a second shape, and companion
// mode's entire claim is that a change arriving through GitHub is not a second
// class of change.
//
// It is a sibling of core/actions-ingest.ts and borrows its two rules. Ingest
// is the single writer for this fact, and idempotency lives in the database —
// GitHub redelivers, and a read-then-write is a race rather than a guarantee.

export interface PullRequestPayload {
  action?: string;
  pull_request?: {
    number?: number;
    title?: string;
    body?: string | null;
    state?: string;
    merged?: boolean;
    draft?: boolean;
    html_url?: string;
    merged_at?: string | null;
    closed_at?: string | null;
    head?: { ref?: string; sha?: string };
    base?: { ref?: string };
    /** Present on a merged pull request; the sha the base branch ends up at. */
    merge_commit_sha?: string | null;
  };
}

// The five actions that change something this row records. GitHub sends a
// dozen more — `labeled`, `assigned`, `review_requested`, `ready_for_review`
// — and every one of them describes upstream bookkeeping a proposal has no
// column for. They are skipped by name rather than absorbed into a catch-all
// refresh: an action nobody has thought about should read as unhandled in the
// response, not silently rewrite the row from whatever the payload happened to
// contain.
const HANDLED_ACTIONS = new Set(["opened", "reopened", "synchronize", "edited", "closed"]);

export interface PullRequestIngestResult {
  recorded: boolean;
  reason?: string;
  /** The proposal number, which under 5a's numbering decision is the upstream one. */
  number?: number;
  /** `created` on first sight, `updated` when a field this row owns moved. */
  change?: "created" | "updated";
  /**
   * Whether this delivery wrote the `proposal.merge` operation `adp undo`
   * resolves — and, when it did not, why. Reported separately from `recorded`
   * because the two are independent: the row can be correctly marked merged by
   * a delivery that could not establish the pre-merge base sha.
   */
  merge?: "recorded" | "already-recorded" | string;
}

type ProposalRow = typeof proposals.$inferSelect;

// What the payload says the proposal should look like now. Split out so that
// the create path and the update path cannot disagree about how a GitHub pull
// request maps onto a proposal — they used to be the same three lines twice,
// which is how the two drift.
function desiredState(pr: NonNullable<PullRequestPayload["pull_request"]>): {
  state: "open" | "closed" | "merged";
  closedAt: Date | null;
  mergedAt: Date | null;
} {
  // A merged pull request is `state: "closed"` upstream with `merged: true`
  // beside it, so the flag is read first — checking `state` alone records
  // every merge as an abandonment.
  if (pr.merged) {
    return {
      state: "merged",
      closedAt: pr.closed_at ? new Date(pr.closed_at) : null,
      mergedAt: pr.merged_at ? new Date(pr.merged_at) : new Date(),
    };
  }
  if (pr.state === "closed") {
    return { state: "closed", closedAt: pr.closed_at ? new Date(pr.closed_at) : new Date(), mergedAt: null };
  }
  return { state: "open", closedAt: null, mergedAt: null };
}

/**
 * Ingest one `pull_request` delivery into a shadow proposal.
 *
 * `actorId` is the mirror's own system identity, the same reporter upstream
 * gate evidence is attributed to: `operations.actorId` and `proposals.authorId`
 * are both hard foreign keys, and the human who opened the pull request on
 * GitHub has no identity row here yet. Resolving them to real people is #230,
 * and is deliberately not this function's business — it would make the row
 * that everything else hangs off wait on identity linking.
 */
export async function ingestPullRequest(
  db: Db,
  gitBackend: GitBackend,
  repo: { id: string; owner: string; name: string },
  mirrorId: string | null,
  actorId: string,
  payload: PullRequestPayload,
): Promise<PullRequestIngestResult> {
  const pr = payload.pull_request;
  if (!payload.action || !HANDLED_ACTIONS.has(payload.action)) {
    return { recorded: false, reason: `ignored action '${payload.action ?? "(none)"}'` };
  }
  if (!pr?.number || !pr.head?.ref || !pr.head.sha || !pr.base?.ref) {
    return { recorded: false, reason: "malformed pull_request payload" };
  }

  const number = pr.number;
  const want = desiredState(pr);
  const title = pr.title ?? `Pull request #${number}`;
  const body = pr.body ?? "";

  const outcome = await db.transaction(async (tx): Promise<PullRequestIngestResult & { row?: ProposalRow }> => {
    // The same repo-row lock the native create path takes to assign a number.
    // Here it is not assigning one — 5a settled that a shadow proposal adopts
    // the upstream number — but it serialises concurrent deliveries of the
    // *same* pull request, which GitHub produces whenever a redelivery races
    // the original.
    const [existing] = await tx
      .select()
      .from(proposals)
      .where(and(eq(proposals.repoId, repo.id), eq(proposals.number, number)))
      .for("update");

    if (existing && existing.upstreamNumber === null) {
      // A natively created proposal already holds this number. Native creation
      // is refused while ingest is on (http-rest/proposals.ts), so this is a
      // proposal that predates the mirror rather than a live collision — and
      // overwriting it would destroy a record to make room for a mirror of one.
      return {
        recorded: false,
        number,
        reason:
          `#${number} in this repository is a natively created proposal, not a shadow of ` +
          `upstream #${number} — refusing to overwrite it`,
      };
    }

    if (!existing) {
      const [row] = await tx
        .insert(proposals)
        .values({
          repoId: repo.id,
          number,
          title,
          body,
          headRef: pr.head!.ref!,
          headSha: pr.head!.sha!,
          baseRef: pr.base!.ref!,
          authorId: actorId,
          upstreamNumber: number,
          upstreamUrl: pr.html_url ?? null,
          state: want.state,
          closedAt: want.closedAt,
          mergedAt: want.mergedAt,
        })
        // Against the partial unique on (repo_id, upstream_number): the row
        // lock above serialises deliveries this instance handles, and this
        // covers the one it cannot — a second server process handling the
        // redelivery. The loser records nothing, which is the right outcome.
        .onConflictDoNothing()
        .returning();

      if (!row) return { recorded: false, number, reason: "concurrent delivery already ingested this pull request" };

      // Recorded as a `proposal.create` because it is one — this row did not
      // exist and now does. `via` distinguishes it from a natively created
      // proposal exactly as it does on a change record (core/change-recorder.ts),
      // so the operations log stays queryable by verb rather than growing a
      // parallel vocabulary for facts that arrived through a mirror.
      await recordOperation(tx, {
        repoId: repo.id,
        actorId,
        verb: "proposal.create",
        target: `${repo.owner}/${repo.name}#${number}`,
        after: {
          id: row.id,
          head: row.headRef,
          base: row.baseRef,
          headSha: row.headSha,
          candidateSetId: null,
          via: "mirror-inbound",
          upstreamUrl: row.upstreamUrl,
        },
      });
      return { recorded: true, number, change: "created", row };
    }

    const next: Partial<ProposalRow> = {};
    if (existing.title !== title) next.title = title;
    if (existing.body !== body) next.body = body;
    if (existing.headSha !== pr.head!.sha) next.headSha = pr.head!.sha!;
    if (existing.headRef !== pr.head!.ref) next.headRef = pr.head!.ref!;
    if (existing.baseRef !== pr.base!.ref) next.baseRef = pr.base!.ref!;
    if (existing.state !== want.state) next.state = want.state;
    if ((existing.closedAt?.getTime() ?? null) !== (want.closedAt?.getTime() ?? null)) next.closedAt = want.closedAt;
    if ((existing.mergedAt?.getTime() ?? null) !== (want.mergedAt?.getTime() ?? null)) next.mergedAt = want.mergedAt;
    if (existing.upstreamUrl !== (pr.html_url ?? null)) next.upstreamUrl = pr.html_url ?? null;

    // Idempotency, and the reason it is spelled as "nothing moved" rather than
    // "I have seen this delivery id": GitHub redelivers, and it also sends
    // `edited` for a label change and `synchronize` for a force-push that
    // resolves to the same sha. All three are the same fact — this row is
    // already right — and none of them should append to an append-only log.
    if (Object.keys(next).length === 0) {
      // Not a return: a delivery that moves nothing about the row can still be
      // the one that completes the merge record below, which is the whole
      // point of keeping the two independent.
      return { recorded: false, number, reason: "no change", row: existing };
    }

    await tx.update(proposals).set(next).where(eq(proposals.id, existing.id));

    // The verb says which of the three things happened, matching what the
    // native routes record for the same transitions, so a reader of the log
    // does not have to know a proposal was ingested to understand its history.
    //
    // A merge is recorded here as an ordinary state change and NOT as
    // `proposal.merge`. That verb carries the before/after base sha `undo.ts`
    // reads, this payload does not contain it, and recording a `proposal.merge`
    // without it would make `adp undo` refuse for the wrong reason — "missing
    // the state needed to undo it" instead of "no such operation". Writing it
    // properly is #225.
    const verb =
      next.state === "closed"
        ? "proposal.close"
        : next.state === "open" && existing.state !== "open"
          ? "proposal.reopen"
          : "proposal.update";

    await recordOperation(tx, {
      repoId: repo.id,
      actorId,
      verb,
      target: `${repo.owner}/${repo.name}#${number}`,
      before: {
        title: existing.title,
        state: existing.state,
        headSha: existing.headSha,
      },
      after: {
        id: existing.id,
        ...next,
        via: "mirror-inbound",
        action: payload.action,
      },
    });

    return { recorded: true, number, change: "updated", row: { ...existing, ...next } as ProposalRow };
  });

  // The merge, recorded outside the row's transaction and idempotently, so that
  // a redelivery arriving after the base branch has caught up can still write
  // the operation a first delivery could not.
  const { row, ...result } = outcome;
  if (row && row.state === "merged" && pr.merge_commit_sha) {
    result.merge = await recordUpstreamMerge(
      db,
      gitBackend,
      repo,
      mirrorId,
      actorId,
      { id: row.id, number: row.number, baseRef: row.baseRef },
      pr.merge_commit_sha,
    );
  }
  return result;
}

/**
 * The refusal a native proposal-create gets on an ingesting repository.
 *
 * Shaped like a land-policy refusal and for the same reason (#145): a user told
 * only that something is refused goes back to the documentation at the moment
 * the product was about to explain itself. So it names the constraint, why it
 * exists, and what to do instead — which here is not an ADP command at all,
 * because in companion mode the pull request belongs on GitHub.
 */
export function nativeProposalRefusal(owner: string, repoName: string) {
  return {
    message:
      `${owner}/${repoName} takes its pull requests from its upstream mirror, so a proposal ` +
      "cannot be created here",
    reason: "pull_request_ingest_enabled",
    remedy:
      "open the pull request on GitHub — it is ingested as a proposal with the same number, " +
      "which is what keeps that number meaning one thing on both planes. Disable the mirror " +
      "first if this repository should own its own proposals.",
  };
}

// ---------------------------------------------------------------------------
// The merge, and the one fact GitHub does not send.
// ---------------------------------------------------------------------------
//
// `undo.ts` resolves a `proposal.merge` operation and reads three things off
// it: `after.mergedInto` (the branch), `after.baseSha` (where that branch ended
// up) and `before.baseSha` (where it was). The first two are in the webhook
// payload. The third is not, and it is the one the compensating-revert path
// actually computes against — `revertTree(onto, after.baseSha, before.baseSha)`
// undoes exactly the range between them.
//
// So a guessed value here is worse than no operation at all. Undo would run,
// succeed, and take out the wrong range; #225 exists because an operation
// missing that state makes undo refuse "for the second reason instead of the
// first", and a *wrong* one is a third and worse outcome. Everything below
// therefore establishes it as a fact or declines to record the merge.
//
// Three sources, in order of how directly each one knows:
//
//   parent   — the merge commit has two or more parents, so it is a true merge
//              commit and its first parent is the base tip it was made on.
//              True by construction, and the case GitHub's default button
//              produces.
//   ref      — the base ref here does not yet contain the merge commit, so it
//              still points where it pointed before. The `pull_request` and
//              `push` deliveries race, and this is the ordering where we can
//              simply read the answer.
//   synclog  — the push already landed, and `mirror_sync_log` recorded where
//              the ref went on each inbound. The row before the newest one for
//              this ref is where it was. Our own record, not an inference.
//
// What is deliberately *not* here is a fourth guess for the remaining case: a
// squash or rebase merge whose push landed before this delivery and whose
// sync log has been pruned. A rebase merge of n commits leaves the pre-merge
// tip at `merge~n`, a squash leaves it at `merge~1`, and nothing in the
// payload distinguishes them. That case reports `merge_base_unknown` and
// writes no operation, so `adp undo` refuses because there is no merge
// recorded — which is true — rather than because a recorded one is unusable.
export type MergeBaseSource = "parent" | "ref" | "synclog";

export interface MergeBaseFact {
  beforeBaseSha: string;
  source: MergeBaseSource;
}

export async function resolveMergeBase(
  db: Db,
  gitBackend: GitBackend,
  repo: { id: string; owner: string; name: string },
  mirrorId: string | null,
  baseRef: string,
  mergeCommitSha: string,
): Promise<MergeBaseFact | null> {
  const commit = await gitBackend.getCommit(repo.owner, repo.name, mergeCommitSha);
  if (commit && commit.parents.length >= 2) {
    return { beforeBaseSha: commit.parents[0]!, source: "parent" };
  }

  const currentBase = await gitBackend.resolveRef(repo.owner, repo.name, baseRef);
  if (currentBase) {
    // "Does the branch already contain the merge?" rather than "is the ref
    // equal to the merge commit?" — a push that carried the merge *and* a
    // commit after it moves the ref past it, and the equality test would read
    // that as "not yet merged" and hand back a sha that is no longer the
    // pre-merge tip.
    const contains =
      currentBase === mergeCommitSha ||
      (await gitBackend.isAncestor(repo.owner, repo.name, mergeCommitSha, currentBase));
    if (!contains) return { beforeBaseSha: currentBase, source: "ref" };
  }

  if (mirrorId) {
    const ref = `refs/heads/${baseRef}`;
    const rows = await db
      .select({ sha: mirrorSyncLog.sha })
      .from(mirrorSyncLog)
      .where(
        and(
          eq(mirrorSyncLog.mirrorId, mirrorId),
          eq(mirrorSyncLog.direction, "inbound"),
          eq(mirrorSyncLog.ref, ref),
          eq(mirrorSyncLog.status, "success"),
        ),
      )
      .orderBy(desc(mirrorSyncLog.createdAt))
      .limit(2);
    // rows[0] is where the ref went last (the merge); rows[1] is where it was
    // before that. Only usable when the newest row really is the merge — if a
    // later push has already been recorded, the pair describes a different
    // move and answering from it would be the guess this function refuses to
    // make.
    if (rows.length === 2 && rows[0]!.sha === mergeCommitSha) {
      return { beforeBaseSha: rows[1]!.sha, source: "synclog" };
    }
  }

  return null;
}

// Whether this proposal already has its merge recorded. Checked by target
// rather than by the proposal row's own state, because the state and the
// operation are written by different deliveries and the operation is the thing
// undo actually resolves.
async function mergeAlreadyRecorded(db: Db, repoId: string, target: string): Promise<boolean> {
  const [row] = await db
    .select({ id: operations.id })
    .from(operations)
    .where(and(eq(operations.repoId, repoId), eq(operations.verb, "proposal.merge"), eq(operations.target, target)))
    .limit(1);
  return !!row;
}

/**
 * Record the `proposal.merge` operation for a pull request merged on GitHub.
 *
 * Separate from the row update, and idempotent on its own, because the two can
 * legitimately happen on different deliveries: the state is knowable from the
 * payload alone and the pre-merge base sha sometimes is not, so a redelivery
 * that arrives once the push has landed must still be able to complete the
 * record. A `pull_request` update that changes nothing about the row will still
 * write this if it is missing.
 */
export async function recordUpstreamMerge(
  db: Db,
  gitBackend: GitBackend,
  repo: { id: string; owner: string; name: string },
  mirrorId: string | null,
  actorId: string,
  proposal: { id: string; number: number; baseRef: string },
  mergeCommitSha: string,
): Promise<string> {
  const target = `${repo.owner}/${repo.name}#${proposal.number}`;
  if (await mergeAlreadyRecorded(db, repo.id, target)) return "already-recorded";

  const fact = await resolveMergeBase(db, gitBackend, repo, mirrorId, proposal.baseRef, mergeCommitSha);
  if (!fact) return "merge_base_unknown";

  await db.transaction(async (tx) => {
    // The race this closes: two deliveries of the same `closed` event both read
    // "not recorded" above. The uniqueness undo depends on is "one merge per
    // proposal", so it is asserted here by re-reading inside the transaction
    // rather than by a constraint — `operations` is an append-only log and must
    // not grow a unique index that a legitimate second merge of a reopened
    // proposal would violate.
    const [existing] = await tx
      .select({ id: operations.id })
      .from(operations)
      .where(and(eq(operations.repoId, repo.id), eq(operations.verb, "proposal.merge"), eq(operations.target, target)))
      .for("update")
      .limit(1);
    if (existing) return;

    await recordOperation(tx, {
      repoId: repo.id,
      actorId,
      verb: "proposal.merge",
      target,
      before: { baseSha: fact.beforeBaseSha },
      after: {
        baseSha: mergeCommitSha,
        mergedInto: proposal.baseRef,
        // GitHub does not report which of its three buttons was pressed, and
        // the operation must not claim to know. `upstream` is what is true:
        // this instance did not perform the merge and did not choose how.
        mergeMethod: "upstream",
        via: "mirror-inbound",
        // How `before.baseSha` was established, kept in the record because a
        // reader auditing an undo should be able to see which of the three
        // sources answered rather than having to re-derive it.
        baseShaSource: fact.source,
      },
    });
  });

  return "recorded";
}
