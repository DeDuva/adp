-- #161: an interim retention default, so ambient capture stops cashing an
-- implicit promise of unbounded retention.
--
-- The shape is the one PLAN.md 3-6 already settled and this does not have to
-- unwind: **reduce payloads, keep the chain.** An aged-out event keeps its seq,
-- its prev_hash, its hash and every typed column; what goes is the payload body.
-- The chain still links, so a run still verifies — and the verification says
-- which state it is in rather than reporting plain success.
--
-- `payload_retained` is deliberately NOT covered by `eventHash`. It cannot be:
-- every row written before this column existed would change what it hashes to,
-- and `verifyChain` would report the entire corpus as tampered — the same
-- reasoning `producer_seq`, `redactions` and `payload_digest` are all written
-- down under in schema.ts. It is a fact about what ADP still holds, not a fact
-- about what the producer sent, and only the second kind belongs in the chain.
ALTER TABLE "session_events" ADD COLUMN IF NOT EXISTS "payload_retained" boolean NOT NULL DEFAULT true;

-- The sweep's claim query is "events in this repo older than the window whose
-- payload is still here", and without this it is a sequential scan of the one
-- table ambient capture makes enormous. Partial, because the rows it must never
-- look at again are the ones it has already reduced.
CREATE INDEX IF NOT EXISTS "session_events_retention_idx"
  ON "session_events" ("occurred_at")
  WHERE "payload_retained";

-- Per-org, null meaning "use the instance default" — the same "absence defers
-- upward" convention the land-policy floors use, rather than M4-3's "null is
-- unlimited". Unbounded is spelled 0, explicitly, so that an org keeping its
-- payloads forever has said so.
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "trajectory_retention_days" integer;
