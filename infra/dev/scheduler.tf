# Cost discipline (docs/environments-plan.md §4, hosting-cost-estimate.md §4):
# an idle VM bills the same as a busy one. Stopping it outside working hours
# cuts compute ~67%.
#
# The floor is not zero: the boot disk and the static IP bill while stopped, so
# the real figure is ~$25/mo against ~$58/mo always-on. Budget the floor, not
# the fantasy.
#
# Trade-off worth knowing: inbound GitHub webhooks are not delivered while the
# instance is stopped, and GitHub does not retry indefinitely. When actively
# testing mirror mode, start the box first:
#   gcloud compute instances start adp-dev --zone <zone>

resource "google_cloud_scheduler_job" "start" {
  count = var.auto_shutdown ? 1 : 0

  project     = var.project_id
  region      = var.region
  name        = "adp-dev-start"
  description = "Start the ADP dev instance on weekday mornings."
  schedule    = var.start_schedule
  time_zone   = var.schedule_timezone

  http_target {
    http_method = "POST"
    uri         = "https://compute.googleapis.com/compute/v1/projects/${var.project_id}/zones/${var.zone}/instances/${google_compute_instance.dev.name}/start"

    oauth_token {
      service_account_email = google_service_account.scheduler[0].email
    }
  }

  depends_on = [google_project_service.enabled]
}

resource "google_cloud_scheduler_job" "stop" {
  count = var.auto_shutdown ? 1 : 0

  project     = var.project_id
  region      = var.region
  name        = "adp-dev-stop"
  description = "Stop the ADP dev instance in the evening, and over the weekend."
  schedule    = var.stop_schedule
  time_zone   = var.schedule_timezone

  http_target {
    http_method = "POST"
    uri         = "https://compute.googleapis.com/compute/v1/projects/${var.project_id}/zones/${var.zone}/instances/${google_compute_instance.dev.name}/stop"

    oauth_token {
      service_account_email = google_service_account.scheduler[0].email
    }
  }

  depends_on = [google_project_service.enabled]
}
