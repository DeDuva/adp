ALTER TABLE "orgs" ADD COLUMN "policy_repo_id" uuid;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "kill_switch" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orgs" ADD CONSTRAINT "orgs_policy_repo_id_repos_id_fk" FOREIGN KEY ("policy_repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
