-- #143: one `changes` row per (repo, sha), enforced rather than assumed.
--
-- Two write paths record a change for the same commit. `post-receive`
-- auto-records a signed row per new commit (#142), and
-- `POST /api/v3/repos/{owner}/{repo}/changes` — the documented way to record a
-- change *with* an intent — inserted unconditionally. `changes` carried an
-- ordinary index on (repo_id, git_sha), not a unique constraint, so the
-- documented push-then-bind sequence left two rows for one sha: one
-- auto-recorded and unbound, one explicit and bound. `getEvidenceBundle` then
-- read them with no ORDER BY and no LIMIT, so which of the two backed the
-- evidence bundle — and therefore whether the bundle showed the intent at all
-- — was not pinned by the code.
--
-- Resolving existing duplicates rather than failing the deploy on them is the
-- opposite call from 0025's, and for a reason. There, duplicate (owner,name)
-- repos could have operations, issues and gate jobs hanging off both ids, so
-- choosing which id keeps that history was an operator decision. Here the
-- duplicates are a *known* shape produced by a known bug, one of the pair is
-- the unbound auto-record, and the rule for picking the survivor is the same
-- rule the fixed code will apply: the bound row wins.
--
-- Order of preference, applied per (repo_id, git_sha):
--   1. a row with a non-null intent_id — the binding is the fact worth keeping;
--   2. among those, and among unbound rows if none is bound, the oldest —
--      it is the one the push recorded, so its id is the one anything else
--      that has seen this change already knows.
--
-- proposals.change_id is the one FK into this table. A proposal that pointed
-- at a losing row is repointed at the survivor before the delete rather than
-- being orphaned or blocking the migration.
CREATE TEMPORARY TABLE "changes_143_survivors" AS
SELECT DISTINCT ON ("repo_id", "git_sha")
       "id" AS "keep_id", "repo_id", "git_sha"
FROM "changes"
ORDER BY "repo_id", "git_sha", ("intent_id" IS NULL), "created_at", "id";
--> statement-breakpoint
UPDATE "proposals" SET "change_id" = "s"."keep_id"
FROM "changes" "c"
JOIN "changes_143_survivors" "s"
  ON "s"."repo_id" = "c"."repo_id" AND "s"."git_sha" = "c"."git_sha"
WHERE "proposals"."change_id" = "c"."id" AND "c"."id" <> "s"."keep_id";
--> statement-breakpoint
DELETE FROM "changes" "c"
USING "changes_143_survivors" "s"
WHERE "s"."repo_id" = "c"."repo_id" AND "s"."git_sha" = "c"."git_sha"
  AND "c"."id" <> "s"."keep_id";
--> statement-breakpoint
DROP TABLE "changes_143_survivors";
--> statement-breakpoint
-- The non-unique index this replaces exists to make exactly this lookup fast
-- (the push path's dedup and the evidence read both filter on the pair). A
-- unique index serves that read identically, so dropping the old one costs
-- nothing and leaving both would mean maintaining two indexes over one pair.
DROP INDEX IF EXISTS "changes_repo_id_git_sha_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "changes_repo_id_git_sha_idx" ON "changes" USING btree ("repo_id","git_sha");
