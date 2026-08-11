CREATE TABLE IF NOT EXISTS "gate_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"git_sha" text NOT NULL,
	"name" text NOT NULL,
	"image" text NOT NULL,
	"command" text NOT NULL,
	"timeout_ms" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"actor_id" uuid NOT NULL,
	"claimed_by" text,
	"exit_code" integer,
	"logs" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gate_jobs" ADD CONSTRAINT "gate_jobs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gate_jobs" ADD CONSTRAINT "gate_jobs_actor_id_identities_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gate_jobs_status_created_at_idx" ON "gate_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gate_jobs_repo_id_git_sha_name_idx" ON "gate_jobs" USING btree ("repo_id","git_sha","name");