ALTER TABLE "gate_jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gate_jobs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill for rows already `running` when this lands: give them a lease as
-- if claimed just now (started_at + timeout + the same 60s grace the claim
-- path uses), so a pre-migration wedged job is reaped on schedule instead of
-- sitting NULL-leased forever — NULL would exempt exactly the rows this
-- migration exists to recover.
UPDATE "gate_jobs"
SET "lease_expires_at" = greatest("started_at", now()) + make_interval(secs => ("timeout_ms" / 1000.0) + 60), "attempts" = 1
WHERE "status" = 'running' AND "lease_expires_at" IS NULL;
