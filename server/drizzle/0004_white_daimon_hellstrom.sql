CREATE TABLE IF NOT EXISTS "gate_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"git_sha" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"reporter_id" uuid NOT NULL,
	"envelope" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gate_results" ADD CONSTRAINT "gate_results_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gate_results" ADD CONSTRAINT "gate_results_reporter_id_identities_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
