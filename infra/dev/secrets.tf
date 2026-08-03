# Secret *values* are deliberately not managed by Terraform.
#
# Any secret Terraform creates a version for is stored in plaintext in its
# state file, which then becomes as sensitive as the secret itself and has to
# be protected accordingly for the rest of the project's life. That trade is
# not worth making for three values that are generated once.
#
# infra/bootstrap.sh creates these secrets and their first versions with
# `gcloud secrets versions add`, reading from `openssl rand`. Terraform
# references them read-only below and manages only the IAM grants — so the
# access policy is still reviewable in a diff, while no secret material ever
# enters state.
#
# Rotation and the retired-key trust model are documented in
# docs/environments-plan.md §4 ("Secrets"). Short version: DSSE envelopes
# already carry `keyid` (server/src/core/dsse.ts), so evidence signed while a
# key was current stays verifiable after rotation; a key marked *compromised*
# is a different and stronger claim than one merely retired.

data "google_secret_manager_secret" "signing_key" {
  project   = var.project_id
  secret_id = "adp-dev-signing-key"

  depends_on = [google_project_service.enabled]
}

data "google_secret_manager_secret" "mirror_credential_key" {
  project   = var.project_id
  secret_id = "adp-dev-mirror-credential-key"

  depends_on = [google_project_service.enabled]
}

data "google_secret_manager_secret" "postgres_password" {
  project   = var.project_id
  secret_id = "adp-dev-postgres-password"

  depends_on = [google_project_service.enabled]
}

# The VM's service account may read these three secrets and nothing else.
# Granted per-secret rather than at project level so a future secret is not
# automatically readable by this host — which matters because
# docs/environments-plan.md §4 requires SIGNING_KEY to stay off any host that
# executes gates, and this host will grow a gate runner before it grows a
# second key.
resource "google_secret_manager_secret_iam_member" "vm_accessor" {
  for_each = {
    signing_key           = data.google_secret_manager_secret.signing_key.secret_id
    mirror_credential_key = data.google_secret_manager_secret.mirror_credential_key.secret_id
    postgres_password     = data.google_secret_manager_secret.postgres_password.secret_id
  }

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vm.email}"
}
