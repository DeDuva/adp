import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { proposals, reviews } from "../db/schema.js";
import { recordOperation } from "./operations.js";

// Ingest for a mirrored repo's upstream reviews.
//
// Without this, 5c publishes a policy verdict that refuses every mirrored pull
// request on a requirement GitHub has already met — which is worse than not
// publishing one at all. A developer who has done the thing the policy asks for
// and is told they have not stops believing the policy.
//
// It depends on #230 having landed first, and not incidentally.
// `evaluateLandPolicy` treats an approval from the proposal's author as no
// approval (#121, on the grounds that the requirement binding self-attestation
// must not be weaker than GitHub's own). While every ingested row was
// attributed to the mirror's system identity, the approver and the author were
// the same identity by construction, so this would have satisfied nothing.

export interface ReviewPayload {
  action?: string;
  review?: {
    id?: number;
    state?: string;
    body?: string | null;
    submitted_at?: string | null;
    user?: { id?: number | null; login?: string | null; type?: string | null };
  };
  pull_request?: { number?: number };
}

// GitHub's review vocabulary, mapped onto the three states `reviews` has.
//
// `dismissed` is not in this map because it is not a review state here — it
// arrives as its own action and sets `dismissed_at` on the review it dismisses.
// Anything unrecognised becomes a comment rather than being dropped: a review
// that exists and is not counted is right, and one that vanishes is not.
export function mapReviewState(state: string | undefined): "approved" | "changes_requested" | "commented" {
  switch (state?.toLowerCase()) {
    case "approved":
      return "approved";
    case "changes_requested":
      return "changes_requested";
    default:
      return "commented";
  }
}

export interface ReviewIngestResult {
  recorded: boolean;
  reason?: string;
  state?: string;
  reviewId?: string;
}

/**
 * Ingest one `pull_request_review` delivery against the shadow proposal it
 * belongs to.
 *
 * `reviewerId` is resolved by the caller through #230 — this function takes an
 * identity rather than a payload user so that it cannot silently fall back to
 * the mirror's system identity, which is the one value that would make the
 * whole item a no-op.
 */
export async function ingestReview(
  db: Db,
  repo: { id: string; owner: string; name: string },
  reviewerId: string,
  payload: ReviewPayload,
): Promise<ReviewIngestResult> {
  const review = payload.review;
  const number = payload.pull_request?.number;
  // `poll` is #228's. A polled review is a *state* rather than an event, and
  // the review list is where a dismissal is visible at all on that path —
  // GitHub reports it as `state: "DISMISSED"` on the review itself rather than
  // as a separate action — so a poll carrying that state is treated as the
  // dismissal it is.
  if (payload.action === "poll" && review?.state?.toLowerCase() === "dismissed") {
    payload = { ...payload, action: "dismissed" };
  }
  if (!payload.action || !["submitted", "edited", "dismissed", "poll"].includes(payload.action)) {
    return { recorded: false, reason: `ignored action '${payload.action ?? "(none)"}'` };
  }
  if (!review?.id || !number) {
    return { recorded: false, reason: "malformed pull_request_review payload" };
  }

  const upstreamId = String(review.id);
  const state = mapReviewState(review.state);
  const body = review.body ?? "";

  return db.transaction(async (tx) => {
    const [proposal] = await tx
      .select()
      .from(proposals)
      .where(and(eq(proposals.repoId, repo.id), eq(proposals.number, number)));
    if (!proposal || proposal.upstreamNumber === null) {
      // The review arrived before the pull request, or for a number this
      // repository holds natively. Neither is an error worth failing the
      // delivery over — GitHub will redeliver, and #224's ingest is what
      // creates the row this hangs off.
      return { recorded: false, reason: `no shadow proposal for #${number}` };
    }

    const [existing] = await tx
      .select()
      .from(reviews)
      .where(and(eq(reviews.proposalId, proposal.id), eq(reviews.upstreamId, upstreamId)))
      .for("update");

    if (payload.action === "dismissed") {
      if (!existing) return { recorded: false, reason: "dismissed a review that was never ingested" };
      if (existing.dismissedAt) return { recorded: false, reason: "no change" };
      await tx.update(reviews).set({ dismissedAt: new Date() }).where(eq(reviews.id, existing.id));
      await recordOperation(tx, {
        repoId: repo.id,
        actorId: reviewerId,
        verb: "review.dismiss",
        target: `${repo.owner}/${repo.name}#${number}`,
        before: { state: existing.state },
        after: { id: existing.id, upstreamId, via: "mirror-inbound" },
      });
      return { recorded: true, state: existing.state, reviewId: existing.id };
    }

    if (existing) {
      if (existing.state === state && existing.body === body) {
        return { recorded: false, reason: "no change", state, reviewId: existing.id };
      }
      await tx.update(reviews).set({ state, body }).where(eq(reviews.id, existing.id));
      await recordOperation(tx, {
        repoId: repo.id,
        actorId: reviewerId,
        verb: "review.update",
        target: `${repo.owner}/${repo.name}#${number}`,
        before: { state: existing.state },
        after: { id: existing.id, state, upstreamId, via: "mirror-inbound" },
      });
      return { recorded: true, state, reviewId: existing.id };
    }

    const [row] = await tx
      .insert(reviews)
      .values({
        proposalId: proposal.id,
        reviewerId,
        state,
        body,
        upstreamId,
        // The upstream submission time, not now. A review's position in the
        // sequence is what decides whether it is a reviewer's current opinion
        // (see latestReviewPerReviewer in land-policy.ts), and ordering
        // ingested reviews by when this instance happened to hear about them
        // would make a redelivery able to change the answer.
        ...(review.submitted_at ? { createdAt: new Date(review.submitted_at) } : {}),
      })
      .onConflictDoNothing()
      .returning();

    if (!row) return { recorded: false, reason: "concurrent delivery already ingested this review", state };

    await recordOperation(tx, {
      repoId: repo.id,
      actorId: reviewerId,
      verb: "review.create",
      target: `${repo.owner}/${repo.name}#${number}`,
      after: { id: row.id, state, upstreamId, via: "mirror-inbound" },
    });

    return { recorded: true, state, reviewId: row.id };
  });
}
