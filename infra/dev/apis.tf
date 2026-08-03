# APIs Terraform itself needs enabled to create the resources below.
# `infra/bootstrap.sh` enables the two that must exist before Terraform can run
# at all (serviceusage, cloudresourcemanager); everything else is managed here
# so the enabled set is reviewable in the diff rather than in shell history.
#
# disable_on_destroy is false deliberately: turning an API off is a
# project-wide action that can break resources this config never created.
locals {
  services = [
    "compute.googleapis.com",
    "secretmanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "cloudscheduler.googleapis.com",
    "artifactregistry.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "oslogin.googleapis.com",
    "iap.googleapis.com",
  ]
}

resource "google_project_service" "enabled" {
  for_each = toset(local.services)

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
