variable "project_id" {
  description = "GCP project ID the dev rung lives in. Created by infra/bootstrap.sh."
  type        = string
}

variable "region" {
  description = "GCP region. us-central1 matches docs/hosting-cost-estimate.md's quoted prices."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "GCP zone for the single dev VM."
  type        = string
  default     = "us-central1-a"
}

# docs/environments-plan.md §3 and docs/hosting-cost-estimate.md §3 both settle
# on e2-standard-2 rather than e2-medium: e2-medium is shared-core with a burst
# credit model, and sustained mirror imports are precisely the workload it
# throttles. A dev box that lies is worth $24/month to avoid.
variable "machine_type" {
  description = "Compute Engine machine type."
  type        = string
  default     = "e2-standard-2"
}

variable "boot_disk_gb" {
  description = "Boot disk size in GB. Holds bare git repos, Postgres data, and Docker images."
  type        = number
  default     = 50
}

variable "hostname" {
  description = <<-EOT
    Public FQDN the instance answers on, e.g. "adp-dev.duckdns.org". Caddy
    requests a Let's Encrypt certificate for exactly this name, so the DNS A
    record must already point at the static IP this config allocates.
  EOT
  type        = string
}

variable "github_repo" {
  description = "owner/name of the GitHub repo allowed to authenticate via workload identity federation."
  type        = string
  default     = "DeDuva/adp"
}

# docs/environments-plan.md §4 ("Cost discipline"): both rungs should have an
# explicit owner and a stated retirement condition, written down when created.
# These are labels rather than comments so they are queryable from the billing
# console, where the question "what is this box and why is it still running?"
# actually gets asked.
variable "owner_email" {
  description = "Who owns this instance. Recorded as a GCP label."
  type        = string
}

variable "retire_after" {
  description = "ISO date after which this instance should be deleted if unused. Recorded as a GCP label."
  type        = string
}

variable "auto_shutdown" {
  description = "Stop the VM outside working hours. Disk and static IP still bill while stopped (~$25/mo vs ~$58/mo always-on)."
  type        = bool
  default     = true
}

variable "start_schedule" {
  description = "Cron for starting the VM. Default: 08:00 Mon-Fri."
  type        = string
  default     = "0 8 * * 1-5"
}

variable "stop_schedule" {
  description = "Cron for stopping the VM. Default: 19:00 Mon-Fri, so it stays off all weekend."
  type        = string
  default     = "0 19 * * 1-5"
}

variable "schedule_timezone" {
  description = "IANA timezone the start/stop crons are interpreted in."
  type        = string
  default     = "America/Los_Angeles"
}

variable "adp_git_ref" {
  description = "Branch or tag of the public ADP repo the instance builds and runs."
  type        = string
  default     = "main"
}
