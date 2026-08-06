ALTER TABLE "runs" ADD COLUMN "labels" jsonb DEFAULT '{}'::jsonb NOT NULL;
