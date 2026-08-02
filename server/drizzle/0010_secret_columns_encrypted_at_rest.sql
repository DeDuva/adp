ALTER TABLE "webhooks" RENAME COLUMN "secret" TO "secret_ciphertext";--> statement-breakpoint
ALTER TABLE "mirrors" RENAME COLUMN "webhook_secret" TO "webhook_secret_ciphertext";
