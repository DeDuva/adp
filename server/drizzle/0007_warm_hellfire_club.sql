CREATE TABLE IF NOT EXISTS "mirrors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"remote_url" text NOT NULL,
	"direction" text DEFAULT 'both' NOT NULL,
	"webhook_secret" text NOT NULL,
	"configured_by_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mirrors_repo_id_unique" UNIQUE("repo_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mirrors" ADD CONSTRAINT "mirrors_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mirrors" ADD CONSTRAINT "mirrors_configured_by_id_identities_id_fk" FOREIGN KEY ("configured_by_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
