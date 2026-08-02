ALTER TABLE "operations" ADD COLUMN "repo_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "operations" ADD CONSTRAINT "operations_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "changes_repo_id_git_sha_idx" ON "changes" USING btree ("repo_id","git_sha");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gate_results_repo_id_git_sha_name_idx" ON "gate_results" USING btree ("repo_id","git_sha","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operations_repo_id_idx" ON "operations" USING btree ("repo_id");