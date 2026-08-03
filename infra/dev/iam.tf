# The VM's identity. Deliberately not the default Compute Engine service
# account, which is Project Editor by default — a dev box that can rewrite its
# own project is a bad default to inherit.
resource "google_service_account" "vm" {
  project      = var.project_id
  account_id   = "adp-dev-vm"
  display_name = "ADP dev instance"
  description  = "Runs the deploy/docker-compose.yml stack on the dev rung."

  depends_on = [google_project_service.enabled]
}

# Just enough to be observable. Secret access is granted per-secret in
# secrets.tf, not here.
resource "google_project_iam_member" "vm" {
  for_each = toset([
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.vm.email}"
}

# Separate identity for the start/stop scheduler jobs, so the ability to power
# the box on and off is not bundled into the box's own credentials.
resource "google_service_account" "scheduler" {
  count = var.auto_shutdown ? 1 : 0

  project      = var.project_id
  account_id   = "adp-dev-scheduler"
  display_name = "ADP dev start/stop scheduler"
  description  = "Starts and stops the dev instance on a schedule (cost discipline, environments-plan.md §4)."

  depends_on = [google_project_service.enabled]
}

resource "google_project_iam_member" "scheduler_compute" {
  count = var.auto_shutdown ? 1 : 0

  project = var.project_id
  role    = "roles/compute.instanceAdmin.v1"
  member  = "serviceAccount:${google_service_account.scheduler[0].email}"
}
