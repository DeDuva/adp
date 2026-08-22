CREATE TABLE IF NOT EXISTS "external_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"identity_id" uuid NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "external_identities_issuer_subject_unique" UNIQUE("issuer","subject")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
