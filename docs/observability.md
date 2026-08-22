# Observability

**Status:** built — M4-11 (`docs/m4-readiness-review.md` §4). Dashboards and alerting over
`/metrics`, on GCP Cloud Monitoring, applied by [`infra/dev/monitoring.tf`](../infra/dev/monitoring.tf).

This document is the operator-facing half: what is measured, what pages, and what to do when
something does. The definitions themselves live in Terraform and in
[`infra/dev/dashboards/adp-overview.json`](../infra/dev/dashboards/adp-overview.json), which are
the applied artifacts — this file explains them and does not duplicate them.

---

## 1. What was already there, and what M4-11 added

`/metrics` has served real Prometheus-format counters since M2 (`server/src/core/telemetry.ts`),
and the acceptance walkthrough has asserted they carry real traffic since then. The readiness
review's §2j reading was that the gap was *dashboards*, not *metrics* — nowhere to look, and
nothing that speaks up.

That reading held with one exception, which M4-11 also closes. §2j was written before M4-9 landed,
and M4-9 shipped four slices of gate-job machinery — a queue, an isolated container executor,
checkout materialization, per-org concurrency caps — with no telemetry at all. The milestone's
largest new component was the one thing the dashboards could not show. So the metric surface grew
by three families, all of them about the queue, and nothing else:

| Family | Type | Labels | What it answers |
|---|---|---|---|
| `adp_http_requests_total` | counter | `method`, `route`, `status` | M2. Traffic shape and error rate, by route pattern |
| `adp_graphql_operations_total` | counter | `operation_type`, `field`, `outcome` | M2. Which GraphQL root fields real clients actually call |
| `adp_gate_jobs` | gauge | `status` | How much work is queued and how much is executing |
| `adp_gate_job_oldest_queued_age_seconds` | gauge | — | How long the oldest unclaimed job has waited |
| `adp_gate_job_completions_total` | counter | `status` | Gate outcomes: `succeeded`, `failed`, `timed_out`, `error` |
| `adp_storage_bytes` | gauge | `org` | M4-3. Bytes an org has stored — Postgres rows plus on-disk git — as of the last meter tick |

**Age, not depth, is the queue's health signal.** A hundred jobs draining in seconds and one job
stuck for an hour are both "the queue is non-empty"; only one of them means the runner fleet is
gone. Depth is charted, age is alerted.

**The gauges are sampled, not counted.** `server/src/core/gate-job-metrics.ts` runs one `GROUP BY`
every 15 seconds. Queue depth is a property of the table, not of the API process — a job can change
state without this process observing it (another replica, an operator's manual fix, a crash between
claim and response), and an in-process running total would drift from the table with nothing to
notice the drift. The sample is deliberately *not* taken inside the `/metrics` handler: that route
is unauthenticated, and a database query behind an unauthenticated endpoint is a way to make the
box do work on request.

**The storage gauge is stale by design, and its staleness is the point.**
`server/src/core/storage-usage.ts` re-measures every org on a ten-minute tick, because the
measurement is a full scan of that org's rows in ten tables — it cannot live on a request path.
That interval is also exactly the overshoot an org can achieve past its byte ceiling, which is why
it is a configured value (`STORAGE_METER_INTERVAL_MS`) and not a constant. An org whose
measurement threw is *dropped from the gauge* rather than carried forward at its last value: a
series that stops is visible on a dashboard, and a stale number that keeps being reported is not.

**Zero and absent are different.** Every non-terminal state is zero-filled rather than omitted, and
every declared family emits its `# HELP`/`# TYPE` header even with no samples — so a dashboard can
be built against a family before the first event of that kind has happened, and "the queue just
drained" does not look like "the exporter died". Before the first sample has been taken, the gauges
emit *nothing*, because a confident zero at that moment would be a lie the alert on it would
believe.

---

## 2. How the numbers get to Cloud Monitoring

```
ADP server ──/metrics──▶ Ops Agent ──▶ Cloud Monitoring ──▶ dashboard + alert policies
(127.0.0.1:3000)         (same VM)      prometheus.googleapis.com/<name>/<counter|gauge>
```

The Ops Agent is installed and configured by [`infra/dev/startup.sh`](../infra/dev/startup.sh) on
every boot (idempotently — it restarts the agent only when the config actually changed). Its scrape
pipeline is named `adp` rather than `default_pipeline`, so it is added to the agent's built-in host
metrics rather than replacing them.

No new provider enters the stack to draw a chart: GCP was already settled for every rung
(`environments-plan.md` §5), and `roles/monitoring.metricWriter` was already granted to the VM's
service account (`infra/dev/iam.tf`) long before there was anything to write.

**`/metrics` is host-local.** `deploy/docker-compose.yml` publishes the server on `127.0.0.1` only,
and `deploy/Caddyfile` answers `/metrics` with a 404 at the public edge. The endpoint is
unauthenticated by design — an operator's scraper is not a repo-scoped resource — which is fine on
a loopback socket and not fine on the open internet. That distinction is the reason the scrape is
local rather than a Cloud Monitoring probe against the public hostname.

**Nothing here can drift silently.** `server/src/observability-coverage.test.ts` parses the real
dashboard JSON and the real Terraform and fails if either names a metric the server does not
export, names one with the wrong type, or if an exported family appears on no dashboard and in no
alert. The reasoning is `spec-coverage.test.ts`'s, one layer out: a tile pointing at a metric that
does not exist renders an empty chart forever, and an empty chart is exactly what a healthy quiet
system also renders.

---

## 3. The alerts

Six policies. Each names a distinct thing that can be wrong and has an action attached; signals
that are interesting but not actionable stayed on the dashboard.

| # | Fires when | Gated? |
|---|---|---|
| 1 | The uptime check against `/healthz` fails from more than one region for 5 min | yes |
| 2 | No `adp_http_requests_total` samples have arrived for 30 min | yes |
| 3 | 5xx responses exceed 0.05/s (≈3/min) for 10 min | no |
| 4 | The oldest unclaimed gate job has waited more than 15 min | no |
| 5 | Gate jobs complete with status `error` for 5 min | no |
| 6 | The oldest *running* gate job is older than 45 min — past every timeout plus the #92 reaper's lease grace, so it means the reaper itself is not running, not that a job is slow | no |

Each policy carries its own runbook in its `documentation` block, which is what Cloud Monitoring
shows in the notification itself — the place an operator is actually reading at the moment it
matters. What follows is the reasoning behind the shapes, which does not belong in a page.

**Why 1 and 2 are gated off by default.** `scheduler.tf` stops this VM every weekday evening and
all weekend, so "the server is not answering" is the expected state for most hours of the week. A
policy that pages nightly for something working as designed does not inform anyone; it teaches the
one person receiving it to ignore the channel, and takes the real alerts down with it. The uptime
check still runs and still records history — only the notification is gated, by
`enable_availability_alerts`, which defaults to the inverse of `auto_shutdown`. A rung meant to
stay up gets both alerts with no extra configuration.

**Why 3, 4 and 5 need no gate.** They are threshold conditions on scraped metrics. A stopped box
produces no data, and a threshold with no data cannot fire. The nightly shutdown is silent here for
free.

**Why the error alert is an absolute rate and not a ratio.** A ratio needs a denominator, and on a
preview instance the denominator is regularly near zero — one failing background request becomes
100% and pages for nothing.

**Why `failed` gate jobs do not page.** A gate that fails is a gate doing its job; alerting on it
means alerting on other people's broken code. `error` means the runner could not run the gate at
all (image pull failed, container refused to start, checkout never arrived) and is ADP's problem.
`timed_out` sits in between — usually the repo's own slow gate — and is charted, not paged.

**Why the uptime check earns its place twice.** It answers the one question the VM's own metrics
structurally cannot: a box whose network, Caddy, or certificate is broken reports nothing at all,
and nothing at all looks identical to idle. It also acts as a heartbeat — a probe every five
minutes keeps `adp_http_requests_total` producing samples on a healthy instance even when no human
is using it, which is what makes alert 2's absence condition mean "the scrape broke" rather than
"nobody was working today".

---

## 4. Applying it

Nothing to do beyond the existing runbook — `terraform apply` in `infra/dev/` creates the channel,
the check, the dashboard and the policies, and the next boot of the VM installs the agent. Two new
variables, both defaulting to what the rest of the config already decided:

| Variable | Default | Set it when |
|---|---|---|
| `alert_email` | `owner_email` | Alerts should go somewhere other than the address already accountable for the box |
| `enable_availability_alerts` | `!auto_shutdown` | You want availability paging on a box that is also scheduled off, or silence on one that is not |

`terraform output dashboard_url` links straight to the dashboard; `terraform output alerting_status`
states in one line how many policies notify, where, and whether the availability pair is on.

**Cost.** The part that bills is metric ingestion. A 30-second scrape is 86,400 samples per series
per month; the active series count is dominated by `adp_http_requests_total`, whose cardinality is
bounded by design — route *patterns*, never raw paths, so a repo explosion or a 404 flood does not
move it. Call it a few hundred series, so tens of millions of samples a month, plus one uptime
check well inside the free allowance. Following `hosting-cost-estimate.md`'s method, the rate to
multiply that by should be re-read from GCP's current list price before anyone commits to it rather
than quoted from here; the shape of the answer is "a rounding error against the ~$25/month the VM
already costs", not a second line item.

To confirm the pipeline end to end on a running instance:

```bash
gcloud compute ssh adp-dev --zone <zone> --project <project> --tunnel-through-iap \
  --command 'curl -s localhost:3000/metrics | head -20 && systemctl is-active google-cloud-ops-agent'
```

If the first half prints metrics and the second prints anything but `active`, it is the agent. If
neither works, it is the server, and alert 1 should already have said so.

---

## 5. What is deliberately not here

- **Traces and profiles.** Nothing in M4 needs a span to answer a question the operation log does
  not already answer better — `operations` is a durable, signed record of every state change,
  which is a strictly stronger artifact than a sampled trace for the questions this system gets
  asked. Revisit when there is a latency problem no one can explain, not before.
- **Per-org labels on the traffic and queue families.** Tempting, given M4's multi-tenancy, and
  deliberately skipped: those families are already labelled by route, field or status, so adding
  org multiplies an existing series count rather than adding one, and Cloud Monitoring bills by
  series. The per-org question those families would answer ("is this org over its quota right
  now?") is answerable exactly and cheaply from the database, which is where quotas live anyway
  (M4-3, M4-9d).

  **`adp_storage_bytes` is the deliberate exception**, added by M4-3, and the distinction is worth
  stating because the bullet above used to be written as a flat "no per-org labels". Three things
  make storage different. It is one series per org, not a multiplier on an existing label set.
  Orgs are provisioned by an admin rather than created by traffic, so the cardinality is bounded
  by a number an operator chose. And the question it answers is not the point-in-time one the
  database answers better — it is *the trend*: an org's bytes over the last month is what tells
  you whether a ceiling will be hit next week, and the database holds only the latest reading. If
  an instance ever has enough orgs for this to cost real money, the fix is to drop the label and
  keep the family, not to stop measuring.
- **Log-based alerting.** The logs are shipped to Cloud Logging by the same agent and are
  searchable; no alert reads them. A log line that matters enough to page for should be a metric.
- **A staging or production rung.** This is the dev rung's monitoring. `environments-plan.md` §3
  sequences the others against M4-8, and the Terraform here is written to move — the only thing
  tying it to dev is which project it is applied in.
