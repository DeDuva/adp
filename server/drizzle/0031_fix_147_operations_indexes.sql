-- #147: index `operations` for the queries actually run against it, and stop
-- the org audit export asking a question no index can answer.
--
-- The operation log is written in the same database transaction as every
-- change — a stated invariant — so it grows with everything else in the
-- system. Today that is one row per push, per merge, per token mint. After
-- ambient capture (#149) it is the surface a person browses to answer "what
-- happened", against a table an order of magnitude larger. It carried one
-- index, on `repo_id` alone, while both readers filter *and sort*.
--
-- Measured at 1M rows (scripts/dev/measure-operations-plans.mjs):
--
--   history: repo + sort              46.3 ms / 19353 blocks  ->  0.1 ms / 23
--   history: repo + verb + sort       48.5 ms / 19321 blocks  ->  2.2 ms / 1134
--   history: repo + actor + since     46.3 ms / 19321 blocks  ->  0.2 ms / 197
--   export:  the org's operations     73.8 ms / 21367 blocks  ->  4.2 ms / 8211
--
-- Every "before" plan contained a Sort over the whole matching slice. The
-- leading column of each index below is the always-present predicate and the
-- rest is the sort key, so the filter and the sort become one ordered index
-- walk that stops at LIMIT.
--
-- The org audit export is NOT solved here, and deliberately not. Carrying
-- `org_id` on every operation would let it ask one indexed question instead of
-- an un-indexable OR — measured at 17 blocks against 21367 — and it was tried
-- and reverted: `operations.org_id` carries a foreign key, so filling it on
-- every row makes every insert take a `FOR KEY SHARE` lock on the org row, one
-- row per tenant, on the write path of every push, merge and gate result.
-- Against `repos`, locked by the same insert, that is a lock-order inversion,
-- and a 50-way workspace fan-out deadlocked on it immediately.
--
-- The export instead asks R+1 indexed questions through a LATERAL join
-- (http-rest/audit-log.ts): 4.2 ms and 8211 blocks against the baseline's
-- 73.8 ms and 21367, with no schema change, no backfill and no new lock.
-- The `org_id` index below is what serves that join's org-level branch.
--
-- 2. The history endpoint: filter on repo_id, sort on (created_at, id).
--
-- Replaces the repo_id-only index rather than joining it: repo_id is the
-- leading column here, so every lookup the old index served this one serves
-- too, and keeping both would mean maintaining two indexes over one prefix on
-- the hottest write path in the system.
DROP INDEX IF EXISTS "operations_repo_id_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operations_repo_id_created_at_idx"
  ON "operations" USING btree ("repo_id","created_at" DESC,"id" DESC);
--> statement-breakpoint
-- 3. The audit export: filter on org_id, same sort.
CREATE INDEX IF NOT EXISTS "operations_org_id_created_at_idx"
  ON "operations" USING btree ("org_id","created_at" DESC,"id" DESC);
