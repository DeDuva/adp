ALTER TABLE "orgs" ADD COLUMN "max_storage_bytes" bigint;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "storage_bytes_used" bigint;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "storage_measured_at" timestamp with time zone;
