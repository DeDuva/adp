CREATE TABLE IF NOT EXISTS "evals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"name" text NOT NULL,
	"git_sha" text NOT NULL,
	"spec_digest" text NOT NULL,
	"score" double precision,
	"passed" boolean NOT NULL,
	"gate_result_id" uuid NOT NULL,
	"trajectory_digest" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"orchestrator" text NOT NULL,
	"external_ref" text,
	"actor_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"final_git_sha" text,
	"trajectory_digest" text,
	"envelope" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"type" text DEFAULT '' NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text,
	"model" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_micro_usd" integer,
	"duration_ms" integer,
	"git_sha" text,
	"related_session_id" uuid,
	"client_event_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"hash" text NOT NULL,
	"prev_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "run_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evals" ADD CONSTRAINT "evals_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evals" ADD CONSTRAINT "evals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evals" ADD CONSTRAINT "evals_gate_result_id_gate_results_id_fk" FOREIGN KEY ("gate_result_id") REFERENCES "public"."gate_results"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runs" ADD CONSTRAINT "runs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runs" ADD CONSTRAINT "runs_intent_id_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."intents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runs" ADD CONSTRAINT "runs_actor_id_identities_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evals_run_id_idx" ON "evals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evals_repo_id_name_idx" ON "evals" USING btree ("repo_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_repo_id_status_idx" ON "runs" USING btree ("repo_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_repo_id_intent_id_idx" ON "runs" USING btree ("repo_id","intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runs_repo_id_orchestrator_external_ref_idx" ON "runs" USING btree ("repo_id","orchestrator","external_ref") WHERE "runs"."external_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_events_session_id_seq_idx" ON "session_events" USING btree ("session_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_events_session_id_client_event_id_idx" ON "session_events" USING btree ("session_id","client_event_id") WHERE "session_events"."client_event_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_events_session_id_occurred_at_idx" ON "session_events" USING btree ("session_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_events_session_id_kind_idx" ON "session_events" USING btree ("session_id","kind");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_run_id_idx" ON "sessions" USING btree ("run_id");