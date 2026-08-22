-- #89 (audit §P0-5/§P0-6): repos(owner,name) becomes unique, repos.org_id
-- becomes NOT NULL and indexed.
--
-- Re-run 0018's idempotent backfill first: every create path has assigned an
-- org since M4-3 and 0018 backfilled everything older, so this should touch
-- nothing — but SET NOT NULL fails on any straggler row, and synthesizing its
-- org here (same rule as 0018: one org per distinct owner string) is strictly
-- better than bricking the migration over a row 0018's own rule can place.
INSERT INTO "orgs" ("name")
SELECT DISTINCT "owner" FROM "repos" WHERE "org_id" IS NULL
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
UPDATE "repos" SET "org_id" = "orgs"."id"
FROM "orgs"
WHERE "repos"."owner" = "orgs"."name" AND "repos"."org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "repos" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
-- Deliberately no dedupe before the unique index: duplicate (owner,name)
-- rows can only exist if the pre-#89 create race actually fired, they may
-- have operations/issues/gate-jobs hanging off both ids, and deciding which
-- id keeps that history is an operator call. If any exist, this CREATE fails
-- loudly and names the problem, which beats silently deleting a repo's record.
CREATE UNIQUE INDEX IF NOT EXISTS "repos_owner_name_idx" ON "repos" USING btree ("owner","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repos_org_id_idx" ON "repos" USING btree ("org_id");
