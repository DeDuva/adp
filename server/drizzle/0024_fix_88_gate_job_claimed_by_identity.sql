ALTER TABLE "gate_jobs" ADD COLUMN "claimed_by_identity_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gate_jobs" ADD CONSTRAINT "gate_jobs_claimed_by_identity_id_identities_id_fk" FOREIGN KEY ("claimed_by_identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
