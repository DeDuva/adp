-- `payload` was NOT NULL with no default, while the events endpoint declares
-- `required: [kind]`. An event carrying only a kind is a legal request by the
-- contract and returned 500 from the not-null constraint, so a recorder could
-- crash its own run mid-experiment by emitting something the spec permits.
--
-- Defaulting is the right half of the fix rather than tightening the spec:
-- `{}` is what a payload-less event means, and a 500 is not something a client
-- can classify or retry. See issue #63.
ALTER TABLE "session_events" ALTER COLUMN "payload" SET DEFAULT '{}'::jsonb;
