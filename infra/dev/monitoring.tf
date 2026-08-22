# M4-11 — observability (docs/m4-readiness-review.md §4, docs/observability.md).
#
# The metrics already existed (`/metrics`, Prometheus text format, since M2);
# what was missing was somewhere to look at them and something to say when
# they go wrong. This file is that: one dashboard, five alert policies, and an
# uptime check, on GCP Cloud Monitoring — the provider environments-plan.md §5
# already settled, so no new vendor enters the stack to draw a chart.
#
# How the numbers get here: the Ops Agent on the VM scrapes
# http://127.0.0.1:3000/metrics over the host loopback (infra/dev/startup.sh)
# and republishes each family as `prometheus.googleapis.com/<name>/<counter|gauge>`
# against the `prometheus_target` monitored resource. `/metrics` itself is not
# reachable from the internet — deploy/Caddyfile refuses it at the edge.
#
# The metric names below are checked against what the server actually exports
# by server/src/observability-coverage.test.ts, in both directions. A tile
# pointing at a metric that does not exist renders an empty chart forever and
# is indistinguishable from a healthy one.

locals {
  # The box already carries an owner label because environments-plan.md §4
  # requires one; alerting anywhere else would mean the person accountable for
  # the instance is not the person who hears about it.
  alert_email = coalesce(var.alert_email, var.owner_email)

  # Availability alerting is OFF by default on this rung, and that is the
  # whole point of the variable: scheduler.tf stops this VM every weekday
  # evening and all weekend, so "the server is not answering" is the expected
  # state most hours of the week. A policy that pages nightly for a thing that
  # is working as designed does not make anyone more informed — it teaches the
  # one person receiving it to ignore the channel, and takes the real alerts
  # down with it. The uptime check itself still runs and still records history
  # either way; only the notification is gated. Set auto_shutdown = false (or
  # this variable to true) on a rung that is meant to be up.
  availability_alerting = coalesce(var.enable_availability_alerts, !var.auto_shutdown)

  # Only the families something below actually alerts on. The other two
  # (`adp_graphql_operations_total`, `adp_gate_jobs`) are charted, not paged
  # on — see dashboards/adp-overview.json, and docs/observability.md for why
  # each of them is a question rather than an emergency.
  prometheus_target = "resource.type=\"prometheus_target\""
  http_requests     = "metric.type=\"prometheus.googleapis.com/adp_http_requests_total/counter\""
  gate_job_age      = "metric.type=\"prometheus.googleapis.com/adp_gate_job_oldest_queued_age_seconds/gauge\""
  gate_running_age  = "metric.type=\"prometheus.googleapis.com/adp_gate_job_oldest_running_age_seconds/gauge\""
  gate_completions  = "metric.type=\"prometheus.googleapis.com/adp_gate_job_completions_total/counter\""
}

resource "google_monitoring_notification_channel" "email" {
  project      = var.project_id
  display_name = "ADP dev owner"
  type         = "email"

  labels = {
    email_address = local.alert_email
  }

  depends_on = [google_project_service.enabled]
}

# Answers "is the public endpoint actually serving?" from outside the VM,
# which is the one question the VM's own metrics structurally cannot answer:
# a box whose network, Caddy, or certificate is broken reports nothing at all,
# and nothing at all looks the same as idle.
#
# It doubles as the heartbeat the absence alert below depends on. A probe
# every five minutes means `adp_http_requests_total` always has fresh samples
# on a healthy instance even when no human is using it — so the series going
# absent means the scrape path broke, not that the box was quiet.
resource "google_monitoring_uptime_check_config" "healthz" {
  project      = var.project_id
  display_name = "adp-dev /healthz"
  timeout      = "10s"
  period       = "300s"

  http_check {
    path           = "/healthz"
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    request_method = "GET"

    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = var.hostname
    }
  }

  depends_on = [google_project_service.enabled]
}

# --- alert policies ---------------------------------------------------------
#
# Five, deliberately. Each one names a distinct thing that can be wrong and
# has an action attached; anything that would only ever be interesting rather
# than actionable stayed on the dashboard instead of becoming a page.

# 1. The instance is not serving. Gated — see local.availability_alerting.
resource "google_monitoring_alert_policy" "unavailable" {
  count = local.availability_alerting ? 1 : 0

  project      = var.project_id
  display_name = "ADP dev — endpoint not serving"
  combiner     = "OR"

  documentation {
    content   = <<-EOT
      The uptime check against https://${var.hostname}/healthz is failing from
      multiple regions.

      Check, in order: is the VM running (`gcloud compute instances list`)? Is
      the compose stack up (`docker compose ps` on the box)? Is Caddy holding a
      valid certificate (`docker compose logs caddy`)?

      docs/observability.md — alert 1.
    EOT
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "uptime check failing"

    condition_threshold {
      filter = join(" ", [
        "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\"",
        "resource.type=\"uptime_url\"",
        "metric.label.check_id=\"${google_monitoring_uptime_check_config.healthz.uptime_check_id}\"",
      ])

      aggregations {
        alignment_period     = "1200s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }

      # More than one probing region reporting failure — one region failing is
      # as likely to be that region as it is to be the service.
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "300s"

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

# 2. The measurement itself stopped. Gated for the same reason as 1: a stopped
#    VM produces exactly this signal.
resource "google_monitoring_alert_policy" "metrics_absent" {
  count = local.availability_alerting ? 1 : 0

  project      = var.project_id
  display_name = "ADP dev — metrics scrape stopped"
  combiner     = "OR"

  documentation {
    content   = <<-EOT
      No `adp_http_requests_total` samples have arrived for 30 minutes, while
      the uptime check keeps the endpoint busy every 5 minutes. The server is
      probably fine and the *scrape* is broken.

      Check the Ops Agent on the box: `systemctl status google-cloud-ops-agent`,
      then `curl -s localhost:3000/metrics | head`. If the second works and the
      first does not, it is the agent; if neither works, the server is down and
      alert 1 should have fired first.

      This alert exists because a dashboard that has quietly stopped receiving
      data looks exactly like a dashboard of a quiet, healthy system.

      docs/observability.md — alert 2.
    EOT
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "no HTTP request samples"

    condition_absent {
      filter   = "${local.http_requests} ${local.prometheus_target}"
      duration = "1800s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

# 3. The server is answering, badly. Not gated: a threshold condition on a
#    stopped box has no data and therefore cannot fire, so the nightly
#    shutdown is silent here without any special handling.
resource "google_monitoring_alert_policy" "server_errors" {
  project      = var.project_id
  display_name = "ADP dev — sustained 5xx responses"
  combiner     = "OR"

  documentation {
    content   = <<-EOT
      The server has been returning 5xx responses at over 0.05/s (roughly 3 a
      minute) for 10 minutes.

      The dashboard's "HTTP requests by status" tile breaks this down by route;
      the server's own logs (`docker compose logs server`) carry the stack.

      Deliberately an absolute rate, not an error *ratio*: a ratio needs a
      denominator, and on a preview instance the denominator is regularly near
      zero — which turns a single failing background request into 100% and
      pages for nothing.

      docs/observability.md — alert 3.
    EOT
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "5xx rate above 0.05/s"

    condition_threshold {
      filter = join(" ", [
        local.http_requests,
        local.prometheus_target,
        "metric.label.status=monitoring.regex.full_match(\"5..\")",
      ])

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }

      comparison      = "COMPARISON_GT"
      threshold_value = 0.05
      duration        = "600s"

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

# 4. Work is queued and nothing is picking it up.
resource "google_monitoring_alert_policy" "gate_job_backlog" {
  project      = var.project_id
  display_name = "ADP dev — gate jobs not being claimed"
  combiner     = "OR"

  documentation {
    content   = <<-EOT
      The oldest unclaimed gate job has been waiting more than 15 minutes.
      Land policy that requires `gates_green` is blocked for as long as this
      lasts, so it is a user-visible stall, not a background inconvenience.

      Likely causes, in order: no runner process is polling
      `/api/adp/gate-jobs/claim`; the runner's token lost the `runner` scope;
      or every one of an org's slots is occupied because
      `orgs.max_concurrent_gate_jobs` (M4-9d) is set too low for its workload.
      The last one is a quota decision, not a fault — check it before
      restarting anything.

      Age, not depth, on purpose: a hundred jobs draining in seconds and one
      job stuck for an hour are both "the queue is non-empty", and only one of
      them is a problem.

      docs/observability.md — alert 4.
    EOT
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "oldest queued gate job older than 15 minutes"

    condition_threshold {
      filter = "${local.gate_job_age} ${local.prometheus_target}"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_MEAN"
        cross_series_reducer = "REDUCE_MAX"
      }

      comparison      = "COMPARISON_GT"
      threshold_value = 900
      duration        = "600s"

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

# 5. The runner cannot run gates at all.
resource "google_monitoring_alert_policy" "gate_job_errors" {
  project      = var.project_id
  display_name = "ADP dev — gate jobs erroring"
  combiner     = "OR"

  documentation {
    content   = <<-EOT
      Gate jobs are completing with status `error` — the runner could not run
      the gate at all (image pull failed, container refused to start, the
      checkout tarball did not arrive).

      Note what is *not* alerted here: `failed`. A gate that fails is a gate
      doing its job, and paging on it would page on other people's broken code.
      `timed_out` is also excluded — it is usually the repo's own gate being
      slow, and it is visible on the dashboard's completions tile.

      docs/observability.md — alert 5.
    EOT
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "gate jobs completing with status=error"

    condition_threshold {
      filter = join(" ", [
        local.gate_completions,
        local.prometheus_target,
        "metric.label.status=\"error\"",
      ])

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }

      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "300s"

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

# 6. A running gate job is wedged past what the reaper should allow.
resource "google_monitoring_alert_policy" "gate_job_wedged" {
  project      = var.project_id
  display_name = "ADP dev — running gate job older than 45 minutes"
  combiner     = "OR"

  documentation {
    content   = <<-EOT
      The oldest *running* gate job has been running for more than 45 minutes.
      Job timeouts cap at 30 minutes and the #92 reaper requeues an expired
      lease within about a minute of it lapsing, so a running job this old
      means the reaper itself is not doing its job: the server process that
      hosts it is down or wedged, its ticks are failing (look for "gate-job
      reaper tick failed" in the server log), or clocks have gone wrong
      enough that leases never look expired.

      This is the failure the queued-age alert (4) structurally cannot see —
      a dead runner's job is precisely NOT queued — and before the reaper
      existed it was the audit's §P1-1: a job wedged `running` forever,
      blocking its commit's land and holding an org concurrency slot.

      docs/observability.md — alert 6.
    EOT
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "oldest running gate job older than 45 minutes"

    condition_threshold {
      filter = "${local.gate_running_age} ${local.prometheus_target}"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_MEAN"
        cross_series_reducer = "REDUCE_MAX"
      }

      comparison      = "COMPARISON_GT"
      threshold_value = 2700
      duration        = "600s"

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

# --- dashboard --------------------------------------------------------------
#
# The JSON lives in its own file rather than inline HCL so it can be exported
# from the console, edited there, and pasted back — which is how dashboards
# actually get iterated on — and so the coverage test can parse it without
# parsing HCL.
resource "google_monitoring_dashboard" "overview" {
  project        = var.project_id
  dashboard_json = file("${path.module}/dashboards/adp-overview.json")

  depends_on = [google_project_service.enabled]
}
