resource "google_compute_instance" "dev" {
  project      = var.project_id
  name         = "adp-dev"
  machine_type = var.machine_type
  zone         = var.zone

  tags = ["adp-dev"]

  # docs/environments-plan.md §4: an explicit owner and a stated retirement
  # condition, recorded where the billing console can surface them.
  labels = {
    environment  = "dev"
    milestone    = "m2"
    owner        = replace(replace(var.owner_email, "@", "-at-"), ".", "-")
    retire-after = var.retire_after
    managed-by   = "terraform"
  }

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = var.boot_disk_gb
      type  = "pd-balanced"
    }
  }

  network_interface {
    network = "default"

    access_config {
      nat_ip = google_compute_address.dev.address
    }
  }

  metadata = {
    # OS Login ties SSH access to IAM instead of to keys pasted into project
    # metadata, so revoking a person's access is an IAM change rather than a
    # key hunt.
    enable-oslogin = "TRUE"

    startup-script = templatefile("${path.module}/startup.sh", {
      project_id = var.project_id
      hostname   = var.hostname
      git_ref    = var.adp_git_ref
    })
  }

  service_account {
    email = google_service_account.vm.email
    # cloud-platform scope with a least-privilege service account is the
    # current recommendation: restrict via IAM roles (iam.tf, secrets.tf),
    # not via the legacy scope mechanism.
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
  }

  # Lets `terraform apply` stop/start the instance to change machine_type
  # instead of refusing, and matches the auto_shutdown lifecycle.
  allow_stopping_for_update = true

  # The scheduler stops and starts this instance, so Terraform must not treat
  # a stopped instance as drift it should "fix" on the next apply.
  lifecycle {
    ignore_changes = [desired_status]
  }

  depends_on = [
    google_project_service.enabled,
    google_secret_manager_secret_iam_member.vm_accessor,
  ]
}
