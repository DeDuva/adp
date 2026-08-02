# Environments plan

**Status:** proposal. Nothing here is built. Decisions marked **OPEN** need an answer before the
work starts; everything else is a recommendation with its reasoning attached.

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

**OPEN — cloud provider.** §4.5 names Hetzner and EC2; the ask here names GCP. These should not
stay split. GCP is a reasonable choice (Cloud SQL, Artifact Registry, and a clean OIDC path from
GitHub Actions with no long-lived keys), but "one VM on Hetzner for prod, GCP for everything else"
is two providers to learn and pay for. Decide once, and update §4.5 to match, rather than letting
the documents drift.

---

## 2. The ladder, and what each rung is for

Each rung earns its place by answering a question the rung below it cannot. If it does not, it is
cost without information.

| Rung | Lifetime | Answers | Exists today |
|---|---|---|---|
| **Ephemeral** (`make up`) | seconds | Does the code work? | yes |
| **Clean room** (`Run-CleanTest.ps1`, `clean-room.yml`) | minutes | Does it work from nothing? | yes |
| **Dev** | weeks, redeployed freely | Does it work *deployed* — real TLS, real DNS, real `gh` against a real hostname? | no |
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

- **One small VM** (GCE `e2-medium`-class) running the existing `deploy/docker-compose.yml`, so the
  artifact under test is the one §4.5 says production will run. Not Cloud Run: the workload needs
  persistent disk for git repos and a Docker socket for gate execution, and fighting that on a dev
  box teaches nothing about the product.
- **A real DNS name and a real certificate** — Caddy already does this automatically, and it is
  what makes `gh` work without the TLS-proxy scaffolding.
- **Deployed by pushing an image**, so the deploy path is exercised continuously rather than by
  hand.
- **Treated as disposable.** No backups, no PITR, wiped without ceremony. The moment it acquires
  data anyone minds losing, it has quietly become staging without the care staging deserves.

Cost is roughly the same order as the single production VM in §4.5.

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
rotation, and a decision about what happens to signatures made with a retired key. **OPEN**, and it
should be answered before the first long-lived instance exists rather than retrofitted.

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

Nothing needs building until M2 begins. When it does, the first task is a public HTTPS endpoint —
which means the dev rung, which means answering the **OPEN** questions above first:

1. One cloud provider, or GCP for dev and Hetzner/EC2 for prod? Update §4.5 either way.
2. `SIGNING_KEY` management for an instance that outlives a single run.
3. Who owns the dev instance, and what condition retires it.
