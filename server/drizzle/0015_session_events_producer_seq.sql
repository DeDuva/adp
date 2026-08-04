ALTER TABLE "session_events" ADD COLUMN "producer_seq" bigint;--> statement-breakpoint
ALTER TABLE "session_events" ADD COLUMN "producer_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_events_session_id_producer_seq_idx" ON "session_events" USING btree ("session_id","producer_seq") WHERE "session_events"."producer_seq" is not null;