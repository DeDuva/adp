-- #232: a GitHub App this instance creates for itself.
--
-- Setting up companion mode cost a personal access token and a webhook created
-- by hand in GitHub's settings, using a URL `adp init` prints as
-- `<your ADP public URL>/…` because it does not know it. Three manual steps and
-- one secret before anything works — and a PAT is the wrong credential shape
-- anyway: it carries the developer's whole account scope, it expires on their
-- schedule rather than the installation's, and revoking it breaks unrelated
-- things. It also cannot do what 5c needs next: GitHub's Checks API refuses
-- personal access tokens outright.
--
-- The manifest flow matters more than the App does. GitHub creates the App in
-- the *user's own* organisation and hands the credentials back to the instance
-- that served the manifest, so a self-hosted deployment gets one-click
-- installation with no hosted control plane in the middle.
--
-- One app per instance, not per org: the App is this deployment's identity to
-- GitHub, and an org here is a tenant inside it. Per-tenant Apps would mean
-- every tenant running the manifest flow, which is the manual setup being removed.
CREATE TABLE IF NOT EXISTS "github_apps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "app_id" text NOT NULL UNIQUE,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "html_url" text NOT NULL,
  "client_id" text NOT NULL,
  -- Encrypted with the same key and mechanism as mirror credentials
  -- (core/mirror-crypto.ts). The private key is the App: whoever holds it can
  -- mint an installation token for every repository the App is installed on.
  "client_secret_ciphertext" text NOT NULL,
  "private_key_ciphertext" text NOT NULL,
  "webhook_secret_ciphertext" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Kept rather than deleted on uninstall. "Uninstalling is clean" means ADP
-- stops receiving events, not that the record of what it ingested while
-- installed disappears — every change, proposal and gate result produced under
-- an installation still points at it.
CREATE TABLE IF NOT EXISTS "github_app_installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "app_id" uuid NOT NULL REFERENCES "github_apps"("id"),
  "installation_id" text NOT NULL,
  "account" text NOT NULL,
  "suspended_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "github_app_installations_app_id_installation_id_unique" UNIQUE ("app_id", "installation_id")
);
