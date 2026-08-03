output "static_ip" {
  description = "Point the DNS A record for var.hostname at this address."
  value       = google_compute_address.dev.address
}

output "public_url" {
  description = "PUBLIC_URL the server is configured with, and the host gh should target."
  value       = "https://${var.hostname}"
}

output "duckdns_update_command" {
  description = "One-time DNS record update. Replace <token> with the token from duckdns.org."
  value       = "curl -s 'https://www.duckdns.org/update?domains=${split(".", var.hostname)[0]}&token=<token>&ip=${google_compute_address.dev.address}'"
}

output "ssh_command" {
  description = "SSH via IAP — port 22 is not open to the internet."
  value       = "gcloud compute ssh adp-dev --zone ${var.zone} --project ${var.project_id} --tunnel-through-iap"
}

output "startup_log_command" {
  description = "Watch the first boot provision itself. The initial docker build takes several minutes on 2 vCPU."
  value       = "gcloud compute ssh adp-dev --zone ${var.zone} --project ${var.project_id} --tunnel-through-iap --command 'sudo tail -f /var/log/adp-startup.log'"
}

output "start_instance_command" {
  description = "Start the box outside its schedule — inbound webhooks are not delivered while it is stopped."
  value       = "gcloud compute instances start adp-dev --zone ${var.zone} --project ${var.project_id}"
}

output "workload_identity_provider" {
  description = "Value for the google-github-actions/auth workload_identity_provider input."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "ci_service_account" {
  description = "Value for the google-github-actions/auth service_account input."
  value       = google_service_account.ci.email
}
