-- #240: run lineage — which run this one follows, and how.
--
-- Sessions already model "Codex continued Claude's unfinished work":
-- `sessions.resumed_from_session_id` is that edge, and #151 built the whole
-- cross-harness resume around it. What they cannot model is "GPT-8
-- independently reimplemented GPT-6's bad change" — that is not a continuation,
-- it is a second attempt at the same intent that deliberately started over, and
-- the two are different historical facts about the same intent.
--
-- Until this, only the first had a column. The second could be recorded as a
-- resume, which is a lie about the trajectory, or as nothing, which is a lie
-- about the history.
--
-- Four relationships, because they are not orderings of one thing: a retry is
-- the same work again after something that was not the work went wrong; a
-- continuation picks up where the parent stopped; a reimplementation starts
-- over from the base without looking at what the parent produced; a supersede
-- is a claim about outcomes rather than method. 2-4 (#176) has to be able to
-- tell the third from the second — an independent second attempt is evidence in
-- a way a continuation is not.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "parent_run_id" uuid REFERENCES "runs"("id");
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "parent_relationship" text;

-- "What followed from this run" is the question lineage exists to answer, and
-- without this it is a sequential scan of every run in the instance.
CREATE INDEX IF NOT EXISTS "runs_parent_run_id_idx" ON "runs" ("parent_run_id");
