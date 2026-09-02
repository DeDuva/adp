-- #224: a GitHub pull request becomes a shadow proposal.
--
-- Mirror inbound handled `push` and `workflow_run` and skipped everything else,
-- so a repository whose pull requests live on GitHub handed ADP a stream of
-- commits and CI verdicts and no object saying what any of it was for. The
-- proposal is that object: `evaluateLandPolicy`, `undo` and the evidence bundle
-- are all written against it already.
--
-- So this adds columns rather than a table. A parallel "external pull request"
-- type would mean reimplementing policy evaluation, the check runs and undo
-- against a second shape, and the whole argument of companion mode is that
-- nothing has to be reimplemented for a change that arrived through GitHub.
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "upstream_number" integer;
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "upstream_url" text;

-- One shadow proposal per upstream pull request, said in the database.
--
-- GitHub redelivers webhooks routinely — the M2 Actions ingest carries the same
-- constraint for the same reason, as a partial unique on
-- (repo_id, external_id). Enforcing it here rather than with a read-then-write
-- is also what makes two concurrent deliveries of the same pull request safe:
-- the constraint picks a winner instead of both of them inserting.
--
-- Partial because it is a statement about ingested rows only. A natively
-- created proposal leaves both columns null, and several nulls in a plain
-- unique index would be several distinct values in Postgres — which happens to
-- work, and works for a reason that has nothing to do with what is being
-- asserted here.
CREATE UNIQUE INDEX IF NOT EXISTS "proposals_repo_upstream_number_idx"
  ON "proposals" ("repo_id", "upstream_number")
  WHERE "upstream_number" IS NOT NULL;
