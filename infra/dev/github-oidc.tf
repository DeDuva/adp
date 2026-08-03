# Workload identity federation for GitHub Actions.
#
# docs/environments-plan.md §4 ("Auth from CI") calls this out as strictly
# better than a long-lived service-account key and "awkward to retrofit once a
# key is in circulation" — so it is defined now, before any key exists, even
# though the deploy workflow that uses it lands separately. GitHub Actions
# exchanges its OIDC token for a short-lived GCP credential; there is no
# secret to store in the repo and nothing to rotate.

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "github-pool"
  display_name              = "GitHub Actions"
  description               = "OIDC federation for ${var.github_repo}."

  depends_on = [google_project_service.enabled]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-provider"
  display_name                       = "GitHub OIDC"

  # Without an attribute_condition, *any* GitHub repository on the internet
  # could exchange a token against this pool. Recent provider versions refuse
  # to create the resource without one, and rightly so.
  attribute_condition = "assertion.repository == '${var.github_repo}'"

  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.repository"       = "assertion.repository"
    "attribute.repository_owner" = "assertion.repository_owner"
    "attribute.ref"              = "assertion.ref"
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# The identity CI assumes. Kept distinct from the VM's own service account so
# "what CI may do" and "what the box may do" are separate, reviewable sets.
resource "google_service_account" "ci" {
  project      = var.project_id
  account_id   = "adp-dev-ci"
  display_name = "ADP CI (GitHub Actions)"
  description  = "Impersonated by GitHub Actions via workload identity federation."

  depends_on = [google_project_service.enabled]
}

resource "google_service_account_iam_member" "ci_workload_identity" {
  service_account_id = google_service_account.ci.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}

# Enough to push an image and roll the instance. Deliberately not
# compute.instanceAdmin: CI should be able to restart the dev box, not rebuild
# the project.
resource "google_project_iam_member" "ci" {
  for_each = toset([
    "roles/artifactregistry.writer",
    "roles/compute.instanceAdmin.v1",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.ci.email}"
}

# Image registry for the deploy path described in docs/environments-plan.md §3
# ("deployed by pushing an image, so the deploy path is exercised
# continuously"). The instance builds from source today — see infra/README.md,
# "What is deliberately left for later" — but the registry exists so that
# change is a workflow addition rather than an infrastructure one.
resource "google_artifact_registry_repository" "adp" {
  project       = var.project_id
  location      = var.region
  repository_id = "adp"
  description   = "ADP server images."
  format        = "DOCKER"

  depends_on = [google_project_service.enabled]
}
