# Dev environment

Terraform for the **dev rung** described in [`docs/environments-plan.md`](../docs/environments-plan.md)
§3 — one small VM running [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) behind a real
DNS name and a real certificate.

**Why it exists:** M2 is mirror mode, and *inbound webhooks cannot be received by a laptop*. That is
the forcing function. A public HTTPS endpoint with a stable hostname is M2's first infrastructure
requirement, not a polish item.

**Cost:** ~$25/month with the default auto-shutdown (~$58 always-on). The floor is not zero — the
boot disk and static IP bill while the instance is stopped. See
[`docs/hosting-cost-estimate.md`](../docs/hosting-cost-estimate.md) §3.

---

## Before you start

You need three things:

1. **An authenticated `gcloud`.** Two separate logins are required — one for the CLI, one for
   Terraform:
   ```
   gcloud auth login
   gcloud auth application-default login
   ```
   The second is not optional and not the same as the first. Terraform authenticates through
   Application Default Credentials; without it you get `could not find default credentials` at
   `plan` time.

2. **A billing account ID.** `gcloud billing accounts list` — it looks like `01ABCD-234567-89EFGH`.

3. **A duckdns subdomain.** Go to [duckdns.org](https://www.duckdns.org), sign in with GitHub, and
   create a subdomain (e.g. `adp-dev-4f21`). Keep the token on that page; you need it once, in
   step 4.

   > **Why duckdns and not nip.io/sslip.io:** those two are *not* on the Public Suffix List, so
   > every subdomain on the internet shares one Let's Encrypt rate limit, which is regularly
   > exhausted. duckdns.org *is* on the list and gets its own quota. A dev box whose TLS randomly
   > fails answers dev's question incorrectly rather than cheaply.

You also need Terraform (`>= 1.5`). The config is plain HCL with no HashiCorp-specific features, so
[OpenTofu](https://opentofu.org) works identically if you prefer an
[MPL-licensed](https://github.com/opentofu/opentofu/blob/main/LICENSE) tool — swap `terraform` for
`tofu` in every command below.

---

## Step by step

### 1. Bootstrap

Terraform cannot create the bucket that stores its own state, and should not hold secret material in
that state at all. This script handles both, plus the APIs that must be enabled before Terraform can
enable anything else.

```
./infra/bootstrap.sh adp-dev-4f21 01ABCD-234567-89EFGH
```

Pick your own project ID — it must be globally unique across all of GCP. The script is safe to
re-run: it checks for each resource before creating it, and **never regenerates a secret value that
already exists** (doing so would change the server's signing identity and orphan every signature it
had already produced).

It creates: the project, the billing link, a versioned GCS state bucket, and three secrets
(`adp-dev-signing-key`, `adp-dev-mirror-credential-key`, `adp-dev-postgres-password`) with random
values from `openssl rand`.

### 2. Configure

```
cd infra/dev
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars
```

Set `project_id`, `hostname` (your duckdns FQDN), `owner_email`, and `retire_after`. The last two are
not decoration — [`environments-plan.md`](../docs/environments-plan.md) §4 requires every long-lived
instance to carry a stated owner and a retirement condition, and they are written as GCP labels so
the billing console can answer "whose box is this, and why is it still running?"

`terraform.tfvars` is gitignored. It names a specific project and a specific person, neither of
which belongs in a public repo.

### 3. Apply

```
terraform init -backend-config="bucket=adp-dev-4f21-tfstate"
terraform plan
terraform apply
```

`plan` first, every time. It is the only cheap moment to notice that something will be destroyed and
recreated rather than updated.

### 4. Point DNS at the instance

The static IP exists after `apply`, so this is the first moment the DNS record can be correct:

```
terraform output duckdns_update_command
```

Run the printed curl with your duckdns token substituted in. Verify before continuing — Caddy will
request a certificate for this name, and Let's Encrypt has failure-rate limits that are annoying to
sit out:

```
dig +short adp-dev-4f21.duckdns.org      # must equal `terraform output static_ip`
```

### 5. Watch the first boot

The first boot installs Docker, clones the repo, and builds the server image. On 2 vCPU that takes
several minutes.

```
$(terraform output -raw startup_log_command)
```

You are waiting for `=== adp startup complete ===`. Then:

```
curl https://adp-dev-4f21.duckdns.org/healthz     # {"status":"ok"}
curl https://adp-dev-4f21.duckdns.org/readyz      # {"status":"ok"} — also proves Postgres
```

A real certificate on a real hostname is the whole point: `gh` refuses plain HTTP for any
non-`github.com` host, which is why `server/acceptance/run.sh` needs a self-signed cert and a TLS
proxy locally. Against this instance that scaffolding disappears:

```
GH_HOST=adp-dev-4f21.duckdns.org gh auth status
```

---

## Operating it

**SSH** goes through Identity-Aware Proxy; port 22 is not open to the internet.

```
gcloud compute ssh adp-dev --zone us-central1-a --tunnel-through-iap
```

**Auto-shutdown** stops the box at 19:00 and leaves it off all weekend
(`start_schedule`/`stop_schedule`). **Inbound GitHub webhooks are not delivered while it is
stopped**, and GitHub does not retry indefinitely — so when you are actively testing mirror mode,
start it first:

```
gcloud compute instances start adp-dev --zone us-central1-a
```

Set `auto_shutdown = false` if that trade stops being worth ~$33/month.

**Redeploying** is a restart: the startup script re-runs on every boot, pulls `adp_git_ref`, and
rebuilds. To pick up `main` without a reboot:

```
gcloud compute ssh adp-dev --zone us-central1-a --tunnel-through-iap \
  --command 'sudo google_metadata_script_runner startup'
```

**Destroying** it costs nothing to redo — that is the point of a disposable rung:

```
terraform destroy
```

Secrets and the state bucket survive `destroy` (they are not Terraform-managed), so a later
`apply` brings back an instance with the *same signing identity*. If you want a genuinely clean
slate, delete the secrets too — but understand that this changes the server's identity.

**Monitoring** is applied with everything else (`monitoring.tf`): a service-overview dashboard, an
uptime check on `/healthz`, and five alert policies over the metrics the server already exports.
The Ops Agent scrapes `/metrics` over the host loopback and republishes it to Cloud Monitoring; the
endpoint is not reachable from the internet.

```
terraform output dashboard_url      # link to the dashboard
terraform output alerting_status    # how many policies notify, where, and whether availability paging is on
```

Two of the five policies — "endpoint not serving" and "metrics scrape stopped" — **do not notify by
default on this rung**, because auto-shutdown stops the box every evening and a nightly page for
working-as-designed behaviour is how an alert channel gets ignored. Set `auto_shutdown = false` (or
`enable_availability_alerts = true`) on a box that is meant to stay up. Alerts go to `owner_email`
unless `alert_email` says otherwise.

What each alert means and what to do about it: [`docs/observability.md`](../docs/observability.md).

---

## Design notes

**Secrets are not in Terraform.** Any secret Terraform writes a version for is stored in plaintext in
its state file, which makes the state as sensitive as the secret for the rest of the project's life.
`bootstrap.sh` creates the values with `gcloud`; Terraform references them read-only and manages only
the IAM grants. The access policy stays reviewable in a diff; the material never enters state.

**The VM does not use the default service account,** which is Project Editor by default. It gets a
dedicated account with `logging.logWriter`, `monitoring.metricWriter`, and `secretAccessor` on
exactly three secrets. This matters ahead of time: `environments-plan.md` §4 requires `SIGNING_KEY`
to stay off any host that executes gates, and this host will grow a gate runner before it grows a
second key.

**Workload identity federation is defined before it is used.** `environments-plan.md` §4 calls it
"awkward to retrofit once a key is in circulation", so the pool, provider and CI service account
exist now — while there is no long-lived key anywhere to migrate away from. The OIDC provider carries
an `attribute_condition` pinning it to one repository; without one, any GitHub repo on the internet
could exchange a token against the pool.

## What is deliberately left for later

- **Image-push deploys.** `environments-plan.md` §3 wants the instance to run a pushed image so the
  deploy path is exercised continuously. Today the box builds from the public repo on boot, which is
  fewer moving parts for a first cut. The Artifact Registry repository and the CI service account
  already exist, so that change is a workflow addition rather than an infrastructure one.
- **Backups.** Dev is explicitly disposable — no backups, no PITR, wiped without ceremony. The moment
  it acquires data anyone minds losing, it has quietly become staging without the care staging
  deserves (`environments-plan.md` §3).
- **Staging.** Sequenced against M4 and its restore drill, not built here.
