-- #227: a GitHub approval satisfies `one_approval`.
--
-- Two columns, and each is there because a review that arrived from upstream
-- has a life a review submitted here does not.
--
-- `upstream_id` because GitHub redelivers and a review has no natural key: two
-- approvals from one person on one proposal is an ordinary sequence, not a
-- duplicate, so there is nothing else to dedup on. Same role `gate_results
-- .external_id` plays for an ingested workflow run.
--
-- `dismissed_at` because GitHub can dismiss a review, and a dismissed approval
-- must stop counting. Recorded rather than deleted: the review happened, and an
-- approval that was withdrawn is a different fact from one that was never
-- given.
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "upstream_id" text;
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "dismissed_at" timestamp with time zone;

CREATE UNIQUE INDEX IF NOT EXISTS "reviews_proposal_upstream_id_idx"
  ON "reviews" ("proposal_id", "upstream_id")
  WHERE "upstream_id" IS NOT NULL;
