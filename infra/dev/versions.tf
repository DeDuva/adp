terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }

  # Partial backend config: the bucket name is supplied at `init` time so this
  # file carries no project-specific state, and so the same tree can point at a
  # second project later without an edit. `infra/bootstrap.sh` creates the
  # bucket (Terraform cannot store its own state in a bucket it has not created
  # yet) and prints the exact `init` line to run.
  backend "gcs" {
    prefix = "dev"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}
