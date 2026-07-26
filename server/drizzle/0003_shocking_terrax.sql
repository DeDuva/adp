ALTER TABLE "tokens" ADD COLUMN "lookup_key" text;--> statement-breakpoint
-- Backfill pre-existing rows with a unique placeholder — they predate keyed
-- lookup, so they simply become unauthenticatable (no production tokens
-- exist yet at this point in the MVP; see docs/pragmatic_mvp.md).
UPDATE "tokens" SET "lookup_key" = md5(random()::text || clock_timestamp()::text || id::text) WHERE "lookup_key" IS NULL;--> statement-breakpoint
ALTER TABLE "tokens" ALTER COLUMN "lookup_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_lookup_key_unique" UNIQUE("lookup_key");