import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { proposals } from "../db/schema.js";
import { recordOperation } from "./operations.js";
import { findMirror } from "./mirrors-lookup.js";

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
  repo: { id: string; owner: string; name: string },
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

  return db.transaction(async (tx) => {
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
      return { recorded: true, number, change: "created" };
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
      return { recorded: false, number, reason: "no change" };
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

    return { recorded: true, number, change: "updated" };
  });
}

/**
 * Whether this repository takes its pull requests from upstream.
 *
 * The signal is the mirror, not a separate switch: an enabled mirror that can
 * receive is a repository whose pull requests are GitHub's, because that is
 * what inbound means. A second flag would be a second thing to get wrong, and
 * the failure it would allow — ingest on, native creation also on — is exactly
 * the collision the numbering decision exists to prevent.
 */
export async function pullRequestIngestEnabled(db: Db, repoId: string): Promise<boolean> {
  const mirror = await findMirror(db, repoId);
  return !!mirror?.enabled && (mirror.direction === "inbound" || mirror.direction === "both");
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
