# A static address, not an ephemeral one. Two reasons: the DNS A record is set
# once by hand (duckdns today, a real domain at a later milestone), and
# auto_shutdown means the instance stops and starts regularly — an ephemeral IP
# would be released on stop and the hostname would go stale every evening.
#
# Note this bills (~$3.65/mo) even while the instance is stopped, which is why
# docs/hosting-cost-estimate.md §3 puts the powered-off floor at ~$25/mo rather
# than near zero.
resource "google_compute_address" "dev" {
  project      = var.project_id
  name         = "adp-dev-ip"
  region       = var.region
  address_type = "EXTERNAL"

  depends_on = [google_project_service.enabled]
}

# 80 and 443 open to the world: 443 is the product, and 80 is required for
# Let's Encrypt's HTTP-01 challenge and for Caddy's redirect to HTTPS.
resource "google_compute_firewall" "web" {
  project = var.project_id
  name    = "adp-dev-allow-web"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["adp-dev"]

  depends_on = [google_project_service.enabled]
}

# SSH is reachable only through Identity-Aware Proxy, never from the open
# internet. 35.235.240.0/20 is IAP's fixed forwarding range; connect with
#   gcloud compute ssh adp-dev --tunnel-through-iap
# This costs nothing and removes the single most-scanned port on the box from
# public view.
resource "google_compute_firewall" "ssh_iap" {
  project = var.project_id
  name    = "adp-dev-allow-ssh-iap"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["adp-dev"]

  depends_on = [google_project_service.enabled]
}
