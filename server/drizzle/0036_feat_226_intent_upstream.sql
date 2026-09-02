-- #226: an intent records which issue it came from, on whose host.
--
-- `intents.source` already distinguished `issue` from `api` and stopped there,
-- so a team organising work in GitHub Issues got an ADP intent universe beside
-- theirs rather than under it. Nothing could answer "is this intent the same
-- piece of work as that issue?" except comparing titles.
--
-- The host is its own column rather than something parsed back out of the URL,
-- because it is the identity half and the URL is a display string: a proxy, an
-- enterprise hostname change or a repository transfer all rewrite the second
-- and none of them change the first. 5-16 has to carry an intent to another
-- instance intact, and "issue 92" means nothing without saying whose 92.
ALTER TABLE "intents" ADD COLUMN IF NOT EXISTS "upstream_host" text;
ALTER TABLE "intents" ADD COLUMN IF NOT EXISTS "upstream_number" integer;
ALTER TABLE "intents" ADD COLUMN IF NOT EXISTS "upstream_url" text;

-- One intent per upstream issue. Partial for the reason #224's index on
-- proposals is: it asserts something about ingested rows and nothing at all
-- about the natively created ones, which leave every column here null.
CREATE UNIQUE INDEX IF NOT EXISTS "intents_repo_upstream_idx"
  ON "intents" ("repo_id", "upstream_host", "upstream_number")
  WHERE "upstream_number" IS NOT NULL;
