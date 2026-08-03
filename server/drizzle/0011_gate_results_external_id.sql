ALTER TABLE "gate_results" ADD COLUMN IF NOT EXISTS "external_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gate_results_repo_id_external_id_idx" ON "gate_results" USING btree ("repo_id","external_id") WHERE "gate_results"."external_id" is not null;
