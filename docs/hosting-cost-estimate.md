# Hosting cost estimate

**Status:** research, closing the open item in [`environments-plan.md`](environments-plan.md) §5
(*"price the shape in §4.5 before provisioning anything"*) and the flagged number in
[`pragmatic_mvp.md`](pragmatic_mvp.md) §4.5.

**Prices verified 2026-08-02** against public list rates: GCP `us-central1` (Iowa), AWS `us-east-1`
(N. Virginia), on-demand, 730 hours/month, USD, no negotiated discount. Cloud list prices move —
re-check before committing money, and treat anything marked *derived* as arithmetic rather than a
quoted rate. Sources are listed at the end.

---

## 1. The headline: §4.5's stated shape costs 4–6× its stated price

§4.5 describes *"an `n2`/`c3-standard` instance, 8–16 vCPU, 64 GB"* and carries a Hetzner-era
`~$100/month`. Priced on GCP:

| §4.5 as written | GCP machine type | List/mo | With SUD | AWS equivalent | List/mo |
|---|---|---:|---:|---|---:|
| 8 vCPU, 64 GB | `n2-highmem-8` | **$382.56** | ~$306 | `r7i.2xlarge` | **$386.17** |
| 16 vCPU, 64 GB | `n2-standard-16` | **$567.17** | ~$454 | `m7i.4xlarge` | $588.38 |
| 8 vCPU, 32 GB | `c3-standard-8` | $294.35 | n/a — C3 has no SUD | `m7i.2xlarge` | $294.34 |

Add ~$20/mo for a 200 GB balanced disk, $3.65/mo for the external IPv4, and egress. **The shape as
written lands at roughly $410–$590/month on GCP list.** The `~$100` figure is not recoverable on
either hyperscaler — that number bought a Hetzner dedicated box, and the memo already knew it was
stale.

Two things are worth noticing beyond the raw multiple:

**"8 vCPU, 64 GB" is not a standard GCP shape.** The 1:8 vCPU-to-GB ratio forces either the
memory-optimized `n2-highmem` tier or a custom machine type (which carries its own premium over
predefined types). The sizing accidentally selects the expensive tier. `n2-standard-8` (8 vCPU,
**32** GB) is $283.58 — a 26% saving for a shape nobody has shown the MVP needs less of.

**The sizing predates knowing the workload.** §4.5 admits this. See §3.

---

## 2. What actually has to run

From [`deploy/docker-compose.yml`](../deploy/docker-compose.yml), the deployed artifact is three
containers — `postgres:16-alpine`, the Fastify server, and `caddy:2-alpine` — over three volumes.
That is the whole production surface today.

> **Drift, since fixed:** §4.5 previously read *"Compose runs server, runner, Postgres, MinIO,
> Caddy"* — naming five services when the committed file has three. Corrected 2026-08-02 to describe
> the three that run, with the object store and gate runner marked as arriving with the features that
> need them (the same correction applied to §4.6's env-var list, which named `OBJECT_STORE_*` and
> `RUNNER_*` as though `server/src/config.ts` validated them). This estimate prices what is
> committed; object storage is priced separately under M4, where it actually appears.

Resource demand, in the order that matters:

1. **Git pack generation** — `git clone`/`git upload-pack` is the CPU and RSS spike in this system,
   not the Node process. M2 is mirror mode, which imports *real GitHub repos with real histories*;
   [`m2-readiness-review.md`](m2-readiness-review.md) explicitly moves scale exposure from M5 to M2
   for exactly this reason.
2. **Gate runners** — untrusted containers via the Docker socket, with CPU/memory/wall-clock caps
   already specified in §4.7. Bursty, and the reason a shared-core instance is a bad idea.
3. **Postgres 16** — comfortable in 2–4 GB at MVP row counts.
4. **Node server + Caddy** — a few hundred MB combined. Effectively free.

The scale envelope in `m2-readiness-review.md` §"The scale envelope, stated" is repos that
materialize in reasonable time on one box — explicitly *not* Chromium-class. Sizing should match
that envelope, not the aspiration.

**Mirror mode keeps the expensive part of CI off this bill entirely.** In mirror mode the repo stays
on GitHub, so GitHub Actions continues to run on GitHub's runners and only its *results* arrive in
ADP, as webhook-ingested evidence (`pragmatic_mvp.md` §2.4 and the M2 milestone). ADP's own gate
runner at M2 therefore carries only the scanner adapters — `wizcli`, `osv-scanner` — over changed
files. That is bursty and small. **No line in this estimate needs to budget for a CI matrix**, which
is a large part of why the right-sized shape in §3 is defensible rather than optimistic.

The corollary is that runner cost becomes real at whatever milestone first makes `adp.yaml`
executable, since that is when repos not on GitHub start running their own gates here. That is also
the point at which the runner host must be separate from the API host for security reasons
independent of cost — see §4.5's trigger note.

---

## 3. Recommended shapes and prices

### Dev rung — needed now, at M2

M2's first task needs a public HTTPS endpoint for inbound webhooks. Smallest thing that answers
dev's question without lying to you:

| Line item | GCP | /mo | AWS | /mo |
|---|---|---:|---|---:|
| Compute (2 vCPU, 8 GB) | `e2-standard-2` | $48.92 | `t4g.large` | $49.06 *(derived)* |
| Disk, 50 GB | pd-balanced @ $0.10/GB | $5.00 | gp3 @ $0.08/GB | $4.00 |
| External IPv4 | $0.005/hr | $3.65 | $0.005/hr | $3.65 |
| Egress (a few GB) | premium tier, 1 GiB free | ~$1 | 100 GB free | $0 |
| **Total** | | **~$58** | | **~$57** |

**Why not `e2-medium`** (which `environments-plan.md` §3 recommended before this estimate, at
$24.46/mo — it has since been updated): it is *shared-core*
with a burst credit model, and 4 GB has to hold Postgres, Node, Caddy, a Docker gate runner, **and**
git pack generation simultaneously. Sustained mirror imports are precisely the workload a burstable
shared-core instance throttles. `e2-medium` is the right pick only if dev's job is narrowly webhook
plumbing and TLS; the moment it is asked to import a real repo it will produce misleading results.
The delta is $24/month — cheap insurance against a dev box that lies.

**Cost discipline** (§4 of the environments plan): stopping the VM nights and weekends cuts compute
~67%, but **disk and the static IP bill while stopped**. A $58 box powered off outside working hours
is ~$25/mo, not ~$19. Budget the floor, not the fantasy.

### Production rung — right-sized

The recommendation is to **not** provision §4.5's stated shape. For one user against a
stated non-Chromium envelope:

| Option | Shape | GCP list | Effective | Notes |
|---|---|---:|---:|---|
| **Recommended** | `n2-standard-4` (4 vCPU, 16 GB) | $141.79 | **~$113** | SUD applies automatically |
| Cheaper | `e2-standard-4` (4 vCPU, 16 GB) | $97.84 | $97.84 | No SUD; shared platform, less consistent CPU |
| Arm | `n4a-standard-4` (4 vCPU, 16 GB) | $112.42 | $112.42 | **See the Arm caveat below** |

Plus 200 GB pd-balanced ($20), IPv4 ($3.65), egress. **~$125–165/month all-in** — against $410–590
for the shape as written. Revisit at M4 with measurements, which is what §4.5 already says.

AWS like-for-like: `m7i.xlarge` (4/16) at $147.17/mo *(derived)*, or `m8g.xlarge` (4/16, Graviton4)
at $131.40/mo.

> **Arm caveat, and it is a product constraint rather than a price one.** `n4a-standard-4` ($112) and
> `m8g.xlarge` ($131) are attractive, and the ADP server is TypeScript with no native-code barrier.
> The constraint is that gate runners will eventually execute **repo-supplied container images**, and
> an arm64 host cannot run x86 images without qemu emulation.
>
> *Timing, corrected 2026-08-02:* that constraint does not bind yet. No executor exists — `adp.yaml`
> parses only gate names (`server/src/core/repo-policy.ts`), and nothing in the tree mounts a Docker
> socket. An Arm API host is therefore viable **today**. It stops being viable on a single colocated
> box the moment `adp.yaml` becomes executable — which is the same moment §4.5 requires the runner
> host to split off anyway. After that split the *API* host can be Arm and the runner pool stays x86,
> so the discount returns permanently. Given the ~$29/mo delta and one migration's worth of churn,
> **x86 now is still the simpler call** — but the reason is inertia, not a live blocker.

### M4 hosted posture — order of magnitude

Not needed yet; included so the M4 decision is not a surprise.

| Component | GCP | /mo | AWS | /mo |
|---|---|---:|---|---:|
| API host | `n2-standard-4` + SUD | ~$113 | `m7i.xlarge` | ~$147 |
| Managed Postgres | Cloud SQL, smallest (1 vCPU/3.75 GB) | ~$30 | RDS `db.t4g.medium` | ~$47 |
| — same, HA/multi-AZ | | ~$60 | Multi-AZ doubles | ~$95 |
| Runner pool, spot | `c3-standard-8` spot | $72.12 (24/7) | `m7i.2xlarge` spot | $131.40 (24/7) |
| Object storage, 100 GB | GCS standard @ $0.020 | $2.00 | S3 standard @ $0.023 | $2.30 |
| Disk snapshots, 200 GB | $0.05/GB (archive $0.019) | $10.00 | EBS snapshot $0.05/GB | $10.00 |

**~$230–300/month** for a realistic M4 shape on either provider, with the runner pool dominant and
highly variable because runners are bursty rather than 24/7.

---

## 4. The levers, ranked by how much they actually save

1. **Right-sizing — $270–450/month.** Dwarfs every other lever combined. This is the entire finding.
2. **Not running dev around the clock — ~$25/month on a $58 box.** Real, but note the disk-and-IP
   floor above.
3. **Sustained Use Discounts — up to 20%, automatic, no commitment.** GCP-only; AWS has no
   equivalent. Applies to N1/N2/N2D/C2/M1/M2 and **not** to E2, C3, C4, N4 or N4A. This inverts the
   naive comparison: `e2-standard-4` at $97.84 looks 31% cheaper than `n2-standard-4` at $141.79,
   but after SUD the real gap is ~14% — and it buys consistent (non-shared) CPU. **Prefer N2 over
   E2** for anything long-lived.
4. **Committed Use Discounts — 37% (1yr) / 55% (3yr). Do not take them yet.** The shape is going to
   change at M4 when runners split onto their own pool and Postgres becomes managed. A one-year
   commitment on the wrong shape is worse than list. Revisit when M4's posture is measured, not
   assumed.
5. **Spot — 53–75% off, and wrong for the main box.** A stateful, long-lived single VM holding git
   repos is the textbook anti-use-case for preemption. Spot is exactly right for two things the plan
   already anticipates: **M3's benchmark machine** (`environments-plan.md` §3 already says rent it,
   run it, destroy it — `c3-standard-8` spot at $0.0988/hr makes a few hours of 8-vCPU benchmarking
   cost roughly a coffee) and **M4's runner pool**, since runners are ephemeral by design.

### Traps

- **Stopped VMs still bill** for persistent disk and reserved static IP.
- **GCP premium-tier egress has only 1 GiB free per month**, against AWS's 100 GB. At $0.12/GB vs
  AWS's $0.09/GB, egress is the one line item where this workload could genuinely diverge — because
  for a git host, egress *is* clone traffic. Noise at MVP scale; not noise once anyone else clones.
  GCP Standard Tier ($0.085/GB, 200 GiB free) undercuts AWS if the degraded network path is
  acceptable, which for a dev rung it is.
- **Backups belong in object storage, not snapshots.** GCS at $0.020/GB beats disk snapshots at
  $0.05/GB — which happens to be what §4.7 already specifies (`git bundle --all` and `pg_dump` to
  the object store). The existing plan is the cheap one; no change needed.

---

## 5. The AWS alternative, and whether it changes anything

**At list price, like-for-like x86 is a dead heat** — close enough to be coincidence:

| Shape | GCP | AWS |
|---|---:|---:|
| 8 vCPU / 32 GB | `c3-standard-8` **$0.4032/hr** | `m7i.2xlarge` **$0.4032/hr** |
| 8 vCPU / 64 GB | `n2-highmem-8` $0.524/hr | `r7i.2xlarge` $0.529/hr |
| 2 vCPU / 4 GB | `e2-medium` $0.0335/hr | `t4g.medium` $0.0336/hr |

Where they genuinely differ:

**GCP is cheaper on:** Sustained Use Discounts (up to 20% for free, no AWS equivalent); Arm —
`n4a-standard-4` at $112.42/mo undercuts `m8g.xlarge` at $131.40/mo for the same 4 vCPU / 16 GB, and
N4A went GA in January 2026; Cloud SQL against RDS at small sizes (~$30 vs ~$47 single-AZ, ~$60 vs
~$95 HA); object storage ($0.020 vs $0.023/GB).

**AWS is cheaper on:** block storage (gp3 $0.08/GB with 3,000 IOPS and 125 MB/s included, vs
pd-balanced $0.10/GB); egress rate ($0.09 vs $0.12/GB premium); egress free tier (100 GB vs 1 GiB).

**Net: within roughly 10% either direction for this workload, with the sign depending mostly on
egress volume.** That is far less than the cost `environments-plan.md` §1 already accepted when it
chose one provider over two — *"two billing relationships, two IAM models and two sets of operational
habits."* A 10% compute delta does not buy that back.

**The GCP decision survives pricing scrutiny and should not be reopened.** What does not survive is
the *sizing*, which is a separate question and the one this document actually answers. The GCP-native
services `environments-plan.md` §1 cited as the reason for the choice — workload identity federation
in particular — are unaffected by any of these numbers.

---

## 6. What this implies for the plan documents

Nothing here changes the single-VM posture, the provider decision, or the milestone sequencing.

**Applied 2026-08-02:**

1. **`pragmatic_mvp.md` §4.5** — the `~$100/month` placeholder and the 8–16 vCPU / 64 GB shape are
   replaced by `n2-standard-4` at ~$113/mo effective (~$125–165 all-in), with the N2-over-E2 and
   no-CUD-yet reasoning recorded inline and the larger sizing deferred to M4 contingent on
   measurement.
2. **`environments-plan.md`** — §5's "price the shape first" item is closed by this document; §3's
   dev shape moves from `e2-medium` to `e2-standard-2` for the burst-throttling reason in §3 above.
3. **`pragmatic_mvp.md` §4.5, §4.6 and the M4 posture** — the compose/config drift this estimate
   surfaced is resolved **in the code's favour**: §4.5 now names the three services
   [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) actually runs, §4.6 separates the env
   vars `server/src/config.ts` validates today from those still planned, and the M4 posture no longer
   claims a MinIO equivalent already sits in `deploy/`. That paragraph now states the constraint as a
   rule with teeth: a managed service may not ship in the hosted posture before its `deploy/`
   equivalent exists, or the self-host path silently becomes second-class.

**Still open, and untouched by cost:** the two questions in `environments-plan.md` §5 —
`SIGNING_KEY` custody (which the §4.5 runner-split trigger has since given a host-placement
dimension) and dev-instance ownership and retirement.

---

## Sources

Verified 2026-08-02. Third-party pricing aggregators were cross-checked against Google's published
per-vCPU and per-GB component rates where possible; `n2-standard-4`, `n2-highmem-8`,
`n2-standard-16`, `e2-medium` and `e2-standard-2` all reconcile to within a cent.

- [GCP VM instance pricing](https://cloud.google.com/compute/vm-instance-pricing) ·
  [Disk and image pricing](https://cloud.google.com/compute/disks-image-pricing) ·
  [VPC network pricing](https://cloud.google.com/vpc/network-pricing) ·
  [Network Service Tiers pricing](https://cloud.google.com/network-tiers/pricing) ·
  [Cloud SQL pricing](https://cloud.google.com/sql/pricing) ·
  [Cloud Storage pricing](https://cloud.google.com/storage/pricing)
- [Sustained use discounts (Compute Engine docs)](https://docs.cloud.google.com/compute/docs/sustained-use-discounts)
- Per-instance GCP rates: [economize.cloud](https://www.economize.cloud/resources/gcp/pricing/compute-engine/n2-standard-4/)
- N4A / Axion: [DoiT N4A benchmark and pricing](https://www.doit.com/blog/first-look-at-google-cloud-n4a-vms-benchmarked-against-n4-c4a-and-aws-m8g) ·
  [gcloud-compute.com n4a-standard-4](https://gcloud-compute.com/n4a-standard-4.html)
- AWS EC2 rates: [instances.vantage.sh](https://instances.vantage.sh/aws/ec2/m7i.2xlarge) ·
  [Amazon EBS pricing](https://aws.amazon.com/ebs/pricing)
- Egress comparison: [EgressCost GCP](https://egresscost.com/gcp/) ·
  [EgressCost AWS](https://egresscost.com/aws/data-transfer-pricing/)
- AWS public IPv4 charge: [AWS News Blog](https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights)
