# Environments plan

**Status:** the **dev** rung is built and its two open decisions are answered (§5) — Terraform in
[`infra/dev/`](../infra/dev/), runbook in [`infra/README.md`](../infra/README.md). **Staging** and
**production** remain proposals, sequenced against M4 (§3). Everything not marked as built is a
recommendation with its reasoning attached.

[`test-environment-automation.md`](test-environment-automation.md) solved *local*: a developer can
create a full environment, run everything, and destroy it, reproducibly. This document is about
the environments that outlive a command — a long-running **dev** instance and a **staging**
instance on real infrastructure — what they are for, when each becomes worth its cost, and how
they relate to the plan of record's hosting position.

---

## 1. The tension with the plan of record

`pragmatic_mvp.md` §4.5 states a **defended** position: *"MVP: one VM + docker compose … Revisit at
M4, not before."* Its defense is good and still holds — the workload is stateful (git repos on
disk), it needs a Docker socket for gate execution, and it has one user. Kubernetes, Fly.io and
serverless each fight at least one of those.

Nothing here overturns that. What it adds is that §4.5 answers *"where does the product run?"* and
is silent on *"where do we try things before they reach that?"* — which is a different question
that becomes pressing at a different time. The proposal is therefore **additive**: keep the
single-VM production posture, and add environments below it as specific milestones create the
need.

**Provider: GCP — decided 2026-08-01.** One provider for every rung, production included. Two
providers would mean two billing relationships, two IAM models and two sets of operational habits,
to save money on one box. §4.5 has been updated to match, so the documents no longer disagree.

What GCP gives this project specifically: Cloud SQL for Postgres with PITR (M4's restore drill),
Cloud Storage for evidence artifacts, Artifact Registry for images, Secret Manager for
`SIGNING_KEY`, and — the one that is awkward to retrofit — **workload identity federation**, so
GitHub Actions authenticates by OIDC with no long-lived service-account key in a secret anywhere.

The cost is that hyperscaler list pricing for a given shape is materially higher than the Hetzner
figure §4.5 was written against. That is a real trade, not a rounding error. *Quantified 2026-08-02
in [`hosting-cost-estimate.md`](hosting-cost-estimate.md):* the premium is **hyperscaler-vs-Hetzner,
not GCP-vs-AWS** — AWS priced within ~10% of GCP in either direction on identical shapes, so this
paragraph's trade is the price of leaving bare metal, and is not reduced by switching cloud. What
the estimate did find is that most of the apparent expense was **sizing** rather than provider.

---

## 2. The ladder, and what each rung is for

Each rung earns its place by answering a question the rung below it cannot. If it does not, it is
cost without information.

| Rung | Lifetime | Answers | Exists today |
|---|---|---|---|
| **Ephemeral** (`make up`) | seconds | Does the code work? | yes |
| **Clean room** (`Run-CleanTest.ps1`, `clean-room.yml`) | minutes | Does it work from nothing? | yes |
| **Dev** | weeks, redeployed freely | Does it work *deployed* — real TLS, real DNS, real `gh` against a real hostname? | **yes** (`infra/dev/`) |
| **Staging** | long-lived, production-shaped | Does it survive real data, upgrades, restores, and other people? | no |
| **Production** | long-lived | — | no (§4.5) |

The two new rungs answer genuinely different questions, which is the argument for eventually
having both and for not building them at the same time.

### What dev is for

The MVP's definition of done depends on things no local run can produce. `gh` refuses plain HTTP
for any non-`github.com` host, so `acceptance/run.sh` fronts the server with a **throwaway
self-signed certificate and a TLS proxy** — a real dev instance with a real DNS name and a real
certificate removes that scaffolding and tests the path an actual user takes. §4.5 already calls
this out: *"a real DNS name with a real certificate is a week-1 requirement, not a polish item."*

Dev is also where the `deploy/` compose stack itself gets exercised. Today CI builds the server but
never deploys it; `deploy/Dockerfile` and `docker-compose.yml` are verified only by being read.

### What staging is for

Staging is about **time**, not correctness: schema migrations against data that already exists,
upgrades over a running instance, backup and restore, and behavior when more than one person is
using it. None of that is observable in an environment that is recreated from empty every run —
which is precisely the property that makes the local rungs valuable.

Staging is therefore worth very little until there is data worth losing, which is why it is
sequenced against M4 below rather than built now.

---

## 3. Sequencing against milestones

The point of tying these to milestones is that each becomes worth its cost at a specific,
identifiable moment — not on a date.

### Dev — when M2 starts

M2 is **mirror mode**: bidirectional GitHub sync via push mirror and webhook ingest, plus outbound
webhooks. **Inbound webhooks cannot be received by a laptop.** That is a hard forcing function, not
a preference — the first M2 task needs a public HTTPS endpoint with a stable hostname, and no
amount of local tooling substitutes for one.

Recommended shape, chosen to be the smallest thing that answers dev's question:

- **One small VM** — GCE **`e2-standard-2`** (2 vCPU, 8 GB) with a 50 GB balanced disk, **~$58/month**
  all-in *(sized 2026-08-02; see [`hosting-cost-estimate.md`](hosting-cost-estimate.md))* — running
  the existing `deploy/docker-compose.yml`, so the artifact under test is the one §4.5 says
  production will run. Not Cloud Run: the workload needs persistent disk for git repos and a Docker
  socket for gate execution, and fighting that on a dev box teaches nothing about the product.
  **Not `e2-medium`** (this document's earlier recommendation, $24/month): it is *shared-core* with a
  burst-credit model, and 4 GB has to hold Postgres, Node, Caddy, a gate runner **and** git pack
  generation at once. Sustained mirror imports — which are the whole point of M2 — are precisely the
  workload a burstable instance throttles, so `e2-medium` would answer dev's question incorrectly
  rather than cheaply. $24/month is worth paying not to be lied to.
- **A real DNS name and a real certificate** — Caddy already does this automatically, and it is
  what makes `gh` work without the TLS-proxy scaffolding.
- **Deployed by pushing an image**, so the deploy path is exercised continuously rather than by
  hand.
- **Treated as disposable.** No backups, no PITR, wiped without ceremony. The moment it acquires
  data anyone minds losing, it has quietly become staging without the care staging deserves.

Cost is roughly half the right-sized production VM in §4.5 — ~$58/month against ~$125–165. Note that
a stopped VM still bills for its disk and static address, so powering it down outside working hours
lands near ~$25/month rather than near zero; budget the floor, not the fantasy.

### Staging — when M4 starts

M4 is the multi-tenant hosted preview: org/user model, OIDC, quotas, managed Postgres, and a
**restore drill** that its exit criteria require to be *executed*, not documented. A restore drill
needs somewhere to restore to that is not production and not empty. That is staging's first real
job, and it does not exist before M4.

Production-shaped by then means: managed Postgres with PITR, object storage, git volume with
snapshots, and gate runners on a **separate** pool — §4.5's own M4 posture, on the grounds that
runners execute untrusted code and must never share a host with the API.

### What does not need an environment

M3 (fleet fan-out, benchmarks, statistical land criteria) is measurement work. It wants a big
machine for a few hours, not a long-lived instance. Rent one, run the benchmark, destroy it — the
local tooling already produces reproducible environments, which is exactly what a benchmark needs.

---

## 4. Consequences worth deciding up front

**Neutrality.** `pragmatic_mvp.md` is explicit that *"hosting is a convenience, never a license
lever."* Every environment here must stay reproducible from `deploy/` by anyone. A dev instance
that quietly depends on a managed GCP service the self-host path lacks would undermine the
project's central claim. Prefer portable services; where a managed one is used, note what the
self-host equivalent is.

**Secrets.** `SIGNING_KEY` is the root of the provenance claim. Local runs mint a random one per
run (`scripts/dev/env.sh`); a long-lived environment needs a real answer — Secret Manager,
rotation, and a decision about what happens to signatures made with a retired key. **Answered
2026-08-02 — see §5.1.**

*Added 2026-08-02:* custody has a **host-placement** half that is easy to miss while framing this as
a secret-storage question. `pragmatic_mvp.md` §4.5 now states the trigger for splitting the runner
host from the API host — the change that first makes `adp.yaml` executable, because a mounted Docker
socket is root-equivalent on its host. `SIGNING_KEY` must never be resident on a host that executes
gates: a gate that can read it can forge evidence, which defeats the provenance claim more
completely than losing the key would. Whatever answer this question gets must therefore survive the
runner/API split, not just satisfy a single-box deployment. Today no executor exists, so nothing is
currently exposed.

**Auth from CI.** GitHub Actions → GCP should use OIDC workload identity federation, not a
long-lived service-account key. It is a strictly better default and awkward to retrofit once a key
is in circulation.

**Cost discipline.** An idle VM costs the same as a busy one. Both rungs should have an explicit
owner and a stated "delete this if unused by X" condition, written down when created.

**Infrastructure as code, from the first resource.** Whatever provisions dev must be checked in and
re-runnable. Everything this project has learned about test environments applies with more force to
one that lives for weeks: a hand-clicked environment drifts, and drift is unreproducible by
construction.

---

## 5. Immediate next step

M2 has begun, so the dev rung is now the live task. It is built:
[`infra/dev/`](../infra/dev/) is the Terraform, [`infra/README.md`](../infra/README.md) is the
runbook.

**Settled:** the provider is GCP, for every rung (§1).

Both questions this section previously left **OPEN** were answered 2026-08-02, before the first
long-lived instance existed rather than after.

### 5.1 `SIGNING_KEY` management — answered

**Custody:** Secret Manager, one secret per environment (`adp-dev-signing-key`), created outside
Terraform so no secret material ever enters Terraform state, and readable only by the instance's
own service account — not the project-default one. See `infra/dev/secrets.tf`.

**The trust-model half — what happens to signatures made with a retired key:**

> A retired key's signatures stay valid for evidence produced while that key was current. A
> **compromised** key's signatures do not. Retirement and compromise are different claims and must
> not share a mechanism.

The reasoning is that evidence is a statement about the past. "These gates were green at this
commit" does not stop being true because the key that attested it was rotated out six months later;
treating rotation as invalidation would make routine key hygiene destroy the audit trail, which
inverts the point of having one. Compromise is the opposite case: once an attacker could have
produced signatures indistinguishable from genuine ones, nothing that key signed can be
distinguished either, so the whole set has to fall.

**This is already largely implemented, which is why the decision is cheap.** DSSE envelopes record
the signing key in `keyid` today (`server/src/core/dsse.ts` sets `keyid: signer.publicKeyHex`), so
every piece of stored evidence already says which key made it. Two pieces are missing and are
deliberately *not* built yet, because a trust model with exactly one key in it cannot be tested:

1. **A key registry** — every public key the instance has used, each with a validity window and a
   status of `current` | `retired` | `compromised`. Verification resolves `keyid` against it.
2. **`verifyEnvelope` resolving through that registry** rather than against a single passed-in
   `Signer`, which is what it does today — so a retired key's evidence would currently fail
   verification even though its `keyid` is right there in the envelope.

Both land when a second key first exists. The obligation this section discharges is that the
envelope format needs no migration to support it, and the operational half (custody, least
privilege, host placement) is settled now.

**Host placement**, per the note in §4: `SIGNING_KEY` must never be resident on a host that executes
gates. Today no executor exists, so the single dev box is fine. The per-secret IAM grant in
`infra/dev/secrets.tf` is written narrowly so that when the runner splits off, granting the runner
host its own credentials does not accidentally hand it this one.

### 5.2 Dev-instance ownership and retirement — answered

**Owner:** recorded as a GCP label on the instance (`owner`), set from `var.owner_email`, so the
billing console can answer "whose box is this?" without asking anyone.

**Retirement condition:** a `retire-after` label carrying an explicit date. Dev is disposable by
design — when that date passes and the box is not in active use, it gets deleted. `terraform
destroy` and a later `terraform apply` reconstitute it with the same signing identity, because the
secrets and the state bucket are not Terraform-managed and survive.

**Cost control:** auto-shutdown at 19:00 on weekdays, off all weekend — ~$25/month against ~$58
always-on. The trade is explicit and worth stating because it has a functional cost, not just a
convenience one: **inbound GitHub webhooks are not delivered while the instance is stopped**, and
GitHub does not retry indefinitely. Mirror-mode testing therefore starts the box first. If that
friction outgrows $33/month, `auto_shutdown = false` is a one-line change.

**And one to do first, before provisioning anything:** ~~price the shape in §4.5~~ — **done
2026-08-02**, in [`hosting-cost-estimate.md`](hosting-cost-estimate.md). The finding: §4.5's stated
8–16 vCPU / 64 GB shape costs **$410–590/month** on GCP list, not `~$100`, and the sizing rather than
the provider is what makes it expensive. Right-sized to `n2-standard-4` the production rung is
~$125–165/month, and the dev rung is ~$58/month. AWS priced within ~10% either direction on the same
shapes, which does not come close to justifying a second provider — **the GCP decision in §1 survives
pricing scrutiny; the sizing in §4.5 does not.** The two consequent edits — `pragmatic_mvp.md` §4.5's
shape and price, and this document's §3 dev shape — **were applied 2026-08-02**.

### 5.3 Asking whether dev is healthy — `make env-status`

Everything above describes a box that redeploys itself from `main` on every scheduled boot and stops
itself every evening, both silently. Until now the way an operator found out either had gone wrong
was by noticing something that depended on it didn't work. `make env-status` asks directly:

```
make env-status          # human-readable, exits 1 on failures, 0 on warnings
make env-status ARGS=--json
```

It answers from four independent vantage points, so a green line means something:

| Section | What it asks | How it asks |
|---|---|---|
| `instance` | is the box on, for how long, and should it be? are the start/stop jobs enabled and did they run? | `gcloud compute instances describe`, `gcloud scheduler jobs describe`, and the schedule from `terraform.tfvars` |
| `dns + tls` | does the hostname still point at the static IP, and how long is the certificate good for? | `dig`/`getent` against `gcloud compute addresses describe`, then `openssl s_client` |
| `app` | do the probes pass, and **is the deployed commit `origin/main`?** | `curl` on `/healthz`, `/readyz`, and `/version` vs `git ls-remote` |
| `derived` | **are inbound webhooks being delivered right now?** | inferred: a stopped instance drops them |
| `cost` | has `retire-after` passed? | the instance label, falling back to `terraform.tfvars` |

Two of those checks exist because nothing else reports them.

**The deployed SHA.** `GET /version` returns `{sha, ref, builtAt, startedAt, uptimeSeconds}`, captured
by `infra/dev/startup.sh` at the moment it deploys and passed into the container — not read per
request, which on a container with no checkout would answer for the wrong tree or not at all. A
deployed SHA behind `origin/main` is a **failure**, not a warning: it means the box is running code
that has already been reviewed away.

**Webhook deliverability.** While the instance is stopped, inbound GitHub webhooks are dropped and
GitHub does not retry indefinitely (§5.2). Nothing on this side records a delivery that never
arrived, so the only honest way to report it is to derive it from power state — which is what the
`derived` section does, before mirror mode silently misses a sync.

Reading the output: **`FAIL` means broken and exits 1**; `warn` means worth knowing and still exits 0
(a box stopped outside its scheduler window warns about dropped webhooks — that is the arrangement
working as designed, not a fault); `--` is context, never a verdict.

`gcloud` is not required. Without it — or with it installed but logged into nothing — the cloud
sections warn and skip, and the DNS, TLS and app checks still run over plain `curl`. Configuration
comes from `infra/dev/terraform.tfvars` (gitignored, so this is the only on-disk record of which box
a checkout provisioned); `ADP_DEV_HOST`, `ADP_DEV_PROJECT`, `ADP_DEV_ZONE`, `ADP_DEV_REGION` and
`ADP_DEV_URL` override it for anyone working against a different one.

