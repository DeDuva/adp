CREATE TABLE IF NOT EXISTS "mirror_sync_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mirror_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"ref" text NOT NULL,
	"sha" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mirrors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"remote_url" text NOT NULL,
	"credential_ciphertext" text NOT NULL,
	"webhook_secret" text NOT NULL,
	"identity_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_outbound_sha" text,
	"last_inbound_sha" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mirrors_repo_id_unique" UNIQUE("repo_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mirror_sync_log" ADD CONSTRAINT "mirror_sync_log_mirror_id_mirrors_id_fk" FOREIGN KEY ("mirror_id") REFERENCES "public"."mirrors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mirrors" ADD CONSTRAINT "mirrors_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mirrors" ADD CONSTRAINT "mirrors_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
