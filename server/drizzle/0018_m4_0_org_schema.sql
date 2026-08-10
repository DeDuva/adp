CREATE TABLE IF NOT EXISTS "org_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_memberships_org_id_identity_id_unique" UNIQUE("org_id","identity_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "org_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "repos" ADD CONSTRAINT "repos_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Backfill (docs/m4-readiness-review.md §4, M4-0): a pre-M4 single-tenant
-- deployment keeps working with no manual step — every existing repo gets
-- assigned to a synthesized org named after its own `owner` string. One org
-- per distinct owner, `orgs.name` unique so this is idempotent: a re-run
-- inserts no duplicate orgs and the `org_id IS NULL` guard on the UPDATE
-- means an already-backfilled repo is untouched.
INSERT INTO "orgs" ("name")
SELECT DISTINCT "owner" FROM "repos"
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
UPDATE "repos" SET "org_id" = "orgs"."id"
FROM "orgs"
WHERE "repos"."owner" = "orgs"."name" AND "repos"."org_id" IS NULL;
