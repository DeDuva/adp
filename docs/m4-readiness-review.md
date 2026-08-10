# M4 Readiness Review

*2026-08-10 · Written between M3 completion and M4 kickoff. Companion to
[`pragmatic_mvp.md`](pragmatic_mvp.md) (the plan of record, amended by this review),
[`m3-readiness-review.md`](m3-readiness-review.md) (its predecessor),
[`environments-plan.md`](environments-plan.md) and [`hosting-cost-estimate.md`](hosting-cost-estimate.md)
(the infra/cost groundwork M4 draws on), and [`ecosystem.md`](ecosystem.md) (what breaks downstream).*

This review answers the same three questions its predecessor did: did M3 actually deliver what its
**Exit:** paragraph promised; was anything in M3 built suboptimally; and is M4 specified well enough
to execute without re-deriving the design at every step.

The summary: **M3 is fully delivered — all five exit criteria met, verified directly against a green
`make check` run, no defects found.** M4 is a different kind of milestone from M3, and that
difference has to be named up front rather than discovered mid-execution: M3 was self-contained
engineering plus benchmarking, fundable and runnable entirely against a local dev instance. M4 names
components that do not exist in this codebase at all today — the runner, the object store, backup/PITR,
a helm chart — and its own exit criterion ("external users can sign up ... restore drill completed")
implies a real hosted environment, real recurring cloud spend, and an identity-provider decision this
review cannot make. §4 below sequences the milestone so the pure-engineering work (which needs no
decision and no budget) is front-loaded and independent of the parts that are blocked on one.

---

## 1. Did M3 meet its exit criteria?

M3's own exit paragraph, restated in §5 of its readiness review, names five checks. Applying them
line by line, against the test suite actually run (`make check`, full `test-all`, 2026-08-10, exit 0):

| # | Exit criterion | Verdict |
|---|---|---|
| 1 | D1 demonstrable: 50 candidates fan out, gates run, one lands with evidence, 49 reclaimed but queryable, comparison view shows it | **Met.** `test/e2e-candidate-fanout.test.ts` — "50-way fan-out resolves to exactly one landed change, with the other 49 reclaimed but still queryable" |
| 2 | D2 demonstrable: a session checkpointed under one harness resumes under another as one signed, lineage-linked history, checkpoint signatures verified at resume | **Met.** `test/e2e-sessions.test.ts` — "a session checkpointed in one harness resumes in another as one signed, linked history"; a second case proves resume refuses a tampered checkpoint |
| 3 | Benchmark published with methodology, deterministic arms distinguished from agent-backed ones, captured run records let a reader re-derive every number | **Met.** All three arms published: arm 1 (`bench/report/merge-contention.md`, CI-enforced), arm 2 (`bench/report/three-way-cost.md`, pilot scale — 12 trials, by design per the M3-5 spec's own pilot-first instruction, not a shortfall against it), arm 3 (squad PR #119) |
| 4 | Statistical gating real and visible: an intermittently-failing gate is quarantined, the quarantine is recorded and surfaced, `gates_confident` lands on a Wilson lower bound | **Met.** `test/e2e-statistical-gating.test.ts` — quarantine and confidence-interval cases both pass |
| 5 | M2 debt paid: a mirrored repo with a >500-commit history has a signed change per commit **on first import**, proven by a test that mirrors rather than pushes over HTTP | **Met.** `test/e2e-mirror.test.ts` — "inbound first import: a >500-commit history ADP has never seen records a signed change per commit" |

No defects found. This is a difference from the M2 review, which found one genuinely unmet criterion
(§1.1 there) — not a lowered bar here, a real one: all five checks above were watched passing directly
in this session's own `make check` run, not inferred from a status line.

### 1.1 One piece of M3 shipped at pilot scale, not full scale, by design

M3-5 arm 2 (three-way cost comparison) ran 12 trials — a pilot slice, per the task that specified it
("pilot slice first ... check actual cost-per-trial ... and only then scale"). `bench/report/three-way-cost.md`
says so on its own front page. This is not a gap against M3's exit criterion, which asked for
"published with methodology," not for a specific N. It is named here because M4's audit-log console
and org policy console (§4 below) are the kind of UI work that tends to get built against whatever
data happens to exist during development — and pilot-scale arm-2 data is exactly that kind of
tempting, too-small fixture. Don't build M4 UI acceptance tests against it.

### 1.2 One process finding worth carrying forward

Running M3-5 arm 2 surfaced a real, previously-undocumented API gap — the native MCP surface has no
tool to open a proposal, only to act on one already in a candidate set (`docs/api-compatibility.md`'s
"Plane dependencies" section, extended 2026-08-10). It was found by driving the *actual* native plane
with an actual agent, not by reading the OpenAPI spec. The M2 review's own lesson (§1.3 there:
"verify against the authority instead of one's own model of it") holds again, one level up: a spec can
be internally consistent and still not describe a usable client. M4's OIDC and SCIM work is the next
place this bites — an OIDC library integrated against a mock IdP proves the code compiles, not that a
real IdP's login flow completes. §4 below sequences a real-IdP check into M4-5 rather than deferring
it to acceptance.

---

## 2. Is M4, as written, executable?

M4's current text (`pragmatic_mvp.md`, restated):

> Org/user model, OIDC login, scoped tokens, quotas and GC. Managed Postgres + object store. The
> instance policy floor generalizes to the org policy plane (org ∧ repo resolution, policy changes as
> signed reviewable changes, fleet kill switch) and the named procurement checklist lands here:
> SSO/SCIM, audit-log export (a projection of `operations`, not a second system), org policy console.
> Backup/PITR with an **executed** restore drill. Runner pool isolation. Observability dashboards.
> Docs, quickstart, self-host artifacts (image + compose + helm).
> **Exit:** external users can sign up and run a real workload; restore drill completed.

Direction is right; nothing here should be dropped. But this list mixes three genuinely different
kinds of work with no signal about which is which, and that ambiguity is the thing this review
resolves rather than the individual sentences:

**a. "Org/user model" names no schema, and nothing it depends on exists yet.** Verified directly
against `server/src/db/schema.ts`: there is no `orgs` table, no org membership table, and `repos.owner`
is a bare `text` column with no foreign key to `identities` at all — not "org-scoped," not scoped to
anything. Every other M4 item that says "org" (policy plane, tokens, quotas, audit export, console)
depends on this landing first, the same shared-surface-first pattern the M3 review applied to its own
schema item (M3-1).

**b. "Scoped tokens" already exists, under a different meaning than M4 needs.** `server/src/auth/plugin.ts`
implements exactly three scopes today — `repo:read`, `repo:write`, `admin` — and they are instance-wide,
not qualified to a repo or an org. M4's "scoped tokens" has to mean *org-scoped*, which is new work on
top of the existing scope check, not a rename of it. Worth stating precisely so nobody reads "scoped
tokens" as already-done.

**c. "Quotas and GC" was explicitly deferred here from M3, and nothing implements either half.**
The M3 review (§4, M3-2) narrowed M3's own GC need to candidate-set-scoped reclamation and left
"general quota-driven GC" for M4 on purpose. Verified: zero occurrences of "quota" anywhere in
`server/src/`. `workspaces.expiresAt`/`destroyedAt` exist as columns but nothing sweeps them — the
only interval-based background job in the whole codebase is the mirror poller
(`core/mirror-poller.ts`, a single `setInterval`). `pragmatic_mvp.md`'s own infrastructure section
names `pg-boss` as the intended job queue; it is not installed or imported anywhere. M4 is building
this mechanism from nothing, not extending one.

**d. "The instance policy floor generalizes to the org policy plane" is precise about the target and
silent about the source.** `core/repo-policy.ts` today resolves land requirements as a union of one
**global, process-wide** floor (`LAND_POLICY_FLOOR` env var) and a repo's own `adp.yaml` — there is no
per-org axis to generalize *from*, because there is no org. "Org ∧ repo resolution" (the milestone's
own phrase) is the right target once M4-a lands; today it would generalize a single env var into
nothing, because the org dimension doesn't exist. Sequenced after org schema for that reason, not
because policy work is hard.

**e. "Fleet kill switch" is named nowhere in code and needs a blast-radius decision before it needs an
implementation.** Zero hits for anything resembling a kill switch in `server/src/`. Before this is an
engineering task it is a product one: does a kill switch freeze new proposals, active gate runs,
token validity, or all three? Does it apply to one identity, one org, or the instance? Flagged in §3
as a design decision, not deferred as unimportant — a kill switch that turns out to be too narrow
during an actual incident is worse than not having named the gap.

**f. "SSO/SCIM" and "OIDC login" both silently assume an identity provider, and none is named
anywhere in this repo's docs.** `environments-plan.md` settles the *cloud* provider (GCP, §5) but
nothing settles the *identity* provider, and SSO/SCIM cannot be built against an abstraction — SCIM in
particular has enough real-world variance between IdPs (Okta vs. Azure AD vs. Google Workspace) that
"generic SCIM support" untested against a real one is exactly the "compiles, doesn't complete a real
login flow" trap §1.2 names. This is the milestone's first hard external-decision blocker.

**g. "Managed Postgres + object store" is the first item with a real, recurring, non-trivial dollar
cost, and nothing in this repo's docs states a budget for it.** `docs/hosting-cost-estimate.md` prices
the *current* (single-VM, no managed services) shape at $410–590/month on GCP list and explicitly
declines to price managed Postgres or object storage, deferring both to "M4, where it actually
appears." They now appear. This needs a number from the author before any provisioning, the same way
M3-5's benchmark arms needed a budget number before the first paid trial.

**h. "Runner pool isolation" reads as hardening an existing thing. It is building a nonexistent
thing.** `runner/` does not exist as a directory in this repo. `pragmatic_mvp.md`'s own layout table
lists it, unbuilt. Gate evidence today arrives only by webhook ingest (GitHub Actions) or direct POST
— ADP does not execute any gate itself yet. "Pool isolation" implies there is a pool to isolate; there
is not one yet, single-tenant or otherwise. This is the milestone's largest single build, and it is
currently invisible inside a five-word phrase.

**i. "Backup/PITR with an executed restore drill" cannot be executed against what exists today.**
`infra/README.md` states the current dev box plainly: "disposable — no backups, no PITR, wiped
without ceremony." A drill needs something to drill against — which means this item is a hard
dependency on M4-g (managed Postgres, which brings PITR as a platform feature on GCP Cloud SQL)
landing and being provisioned first, not parallel work.

**j. "Observability dashboards" has a real head start the milestone text doesn't credit.**
`/metrics` (`main.ts`) already serves real Prometheus-format counters for both REST and GraphQL
(confirmed passing in acceptance: "D13 /metrics carries real REST and GraphQL counters"). What's
missing is *dashboards*, not *metrics* — a materially smaller gap than "observability" suggests, and
one with a low-decision default available: GCP Cloud Monitoring can scrape the existing endpoint
without introducing a new provider, since GCP is already settled.

**k. Self-host artifacts are two-thirds done.** `deploy/` already has a `Dockerfile` and
`docker-compose.yml`; only `helm/` is missing (confirmed: no `helm/` directory anywhere in the repo).
Docs/quickstart is the remaining unscoped piece of this item.

**l. The exit criterion's "external users can sign up" is D1-shaped ambiguous, the same way M3's D1
text was.** Does this mean a public-internet-reachable signup flow, or a real user completing signup
and a workload against a preview instance the author controls access to? Read literally it implies
public availability; nothing else in M4's scope (no rate-limiting-for-abuse, no billing, no ToS) is
sized for that. §3 resolves this the same way the M3 review resolved D1: state the narrower reading
the rest of the milestone is actually built for, so it doesn't get discovered as a scope mismatch at
the end.

---

## 3. Milestone adjustments

Applied to `pragmatic_mvp.md`'s M4 section by this review — recorded here first since, per the
roadmap-consolidation convention (#69), `pragmatic_mvp.md` is where scope decisions live and
`ROADMAP.md` is where status lives; this review is the paper trail for the former.

**M4 — clarifications (no scope added).**
- *"Scoped tokens" means org-scoped*, additive to the three existing instance-wide scopes
  (`repo:read`/`repo:write`/`admin`), not a replacement for them.
- *"Quotas and GC" is new infrastructure*, not an extension of the mirror poller's `setInterval`
  pattern at the scale M4 needs — a real scheduled-job mechanism (`pg-boss`, already named in
  `pragmatic_mvp.md`'s infra section, never installed) is in scope here for the first time.
- *"Org policy plane" generalizes an env var into a real per-org axis*, and depends on the org schema
  landing first (M4-0 in §4) — it cannot be built in parallel with it.
- *"External users can sign up and run a real workload" means against a preview instance the author
  controls access to*, not public general availability. Nothing else in M4's scope (abuse
  rate-limiting, billing, ToS, support) is sized for public GA, and reading the exit criterion that
  way would silently expand the milestone by an amount nothing else here accounts for.
- *"Runner pool isolation" is "build the runner, isolated from the start"*, not "isolate an existing
  runner" — there is no existing runner. Isolation requirements (network-deny, no host mounts,
  CPU/memory/wall-clock caps, process separation from the API host) are designed in from M4-9's first
  line, not retrofitted.

**M4 — additions (two, both forced by findings above, both small).**
- *A stated kill-switch blast radius*, decided before M4-2 (org policy plane) is implemented, not
  after: what a kill switch freezes (new proposals / active gate runs / token validity), and at what
  scope (identity / org / instance).
- *A real-IdP check for OIDC and SCIM*, not just a compile-time integration against a mock. Named in
  M4-5 and M4-6 below, in the same spirit §1.2 draws from arm 2's own experience.

**Decisions this review cannot make, named explicitly so they aren't silently defaulted:**
1. **Which identity provider** OIDC login and SCIM are built and tested against (blocks M4-5, M4-6).
2. **A budget number** for managed Postgres and object storage (blocks M4-8, and transitively M4-10 —
   the backup/PITR drill needs M4-8 provisioned).
3. **Whether the restore drill runs against a real provisioned preview instance now**, or is deferred
   until closer to the rest of M4 landing (affects sequencing of M4-8 relative to everything else, and
   whether M4-8's cost is incurred early or late in the milestone).

**M5 — unchanged.** Nothing here revisits the M5 evidence gate; M4's own telemetry (once a real
preview instance exists under real, not synthetic, load) is one of the citations a future M5
justification would need, same relationship M3's telemetry has to M5 today.

---

## 4. The M4 work plan

Ordered. Items marked **[blocked: decision N]** cannot start until the corresponding numbered decision
in §3 is made — everything else can start immediately and needs no budget or provider choice.
Conventions unchanged from M3: branch off `main`, land via PR, `make check` (or the repo's equivalent
of `make test-all`) green before opening it, new tables get a Drizzle migration, every state change
goes through `recordOperation`.

### Track A — pure engineering, unblocked, start here

**M4-0 — Org/user schema.** `orgs` table (id, name, created_at); `org_memberships` (org_id, identity_id,
role); `repos.org_id` FK, nullable at first with a backfill migration assigning every existing repo to
a synthesized org per its current `owner` string (existing single-tenant deployments must not break).
One migration, landed first — the M3-1 pattern repeats: every other M4 item touching `orgs` collides on
this file if built in parallel, so it lands alone before the rest fan out.

**M4-1 — Org-scoped tokens.** Extend `tokens` with an optional `org_id`; extend `hasScope()`
(`auth/plugin.ts`) to check org membership when a route is org-scoped. The three existing scopes stay;
this adds the org axis alongside them, not instead.

**M4-2 — Org policy plane.** `resolveLandRequirements()` (`core/repo-policy.ts`) generalizes from
`instanceFloor ∪ repoPolicy` to `instanceFloor ∪ orgFloor ∪ repoPolicy` — org can only add
requirements, same non-relaxation invariant the instance floor already enforces on repos. Org policy
changes go through the same intent→diff→evidence→provenance path as code (a policy file, versioned,
proposed, reviewed, landed) rather than a bare admin API call — "signed reviewable changes" in the
milestone's own words. Kill switch lands here, at the blast radius decided in §3: minimally, a boolean
on the org row that `resolveLandRequirements()` and the auth middleware both check, refusing new
proposals and land attempts org-wide when set.

**M4-3 — Quotas and GC.** Introduce `pg-boss` (already named as the intended mechanism, never
installed) as the first real job queue in this codebase. First consumer: a sweeper for
`workspaces.expiresAt`/`destroyedAt`, generalizing the reclamation M3-2 built for candidate sets to a
scheduled job rather than an on-demand call. Quota concept: per-org limits (repo count, concurrent
workspaces, storage — the last blocked on M4-8's object store existing to meter against). Land the
mechanism and the workspace sweeper first; storage quota is a follow-on once M4-8 exists.

**M4-4 — Audit-log export.** The best-specified item in the whole milestone — "a projection of
`operations`, not a second system" already says what to build. An export endpoint reading the existing
`operations` table, filtered by org (once M4-0 lands) and time range, paginated, in a format a
compliance tool can ingest (CSV or NDJSON). No new storage, no new write path — read-only against data
that already exists and is already signed.

**M4-9 — Runner pool isolation.** The largest build in the milestone and, per §2h, currently a
from-scratch component, not a hardening pass. Container gate executor, `pg-boss`-backed job queue
(shared mechanism with M4-3), isolation designed in from the start: network-deny by default, no host
mounts, CPU/memory/wall-clock caps enforced per job, and the runner process on a separate host from the
API server — `pragmatic_mvp.md`'s own stated reason ("a mounted Docker socket is root on the host") is
the one this review found no code contradicting, so it stands as the design. Per-org isolation (queue
partitioning, resource caps scoped to org quota from M4-3) is this component's own multi-tenancy story,
not bolted on after a single-tenant version ships.

**M4-11 — Observability dashboards.** Per §2j, the metrics already exist; this item is dashboards and
alerting over them. Default (low-decision, since GCP is already settled per `environments-plan.md`
§5): GCP Cloud Monitoring scraping `/metrics`, no new provider introduced. Escalate to an explicit
choice only if self-hosted Grafana is wanted for a reason this review doesn't have visibility into.

**M4-12 — Self-host artifacts.** `helm/` chart (the one missing piece — Dockerfile and compose already
exist), plus docs/quickstart. Sequenced last in Track A deliberately: it should describe the *final*
shape of the multi-tenant deploy (org schema, runner, object store config), not the pre-M4 one, or it
becomes stale the day the rest of the milestone lands.

### Track B — blocked on a decision named in §3

**M4-5 — OIDC login.** **[blocked: decision 1]** Once an IdP is named: standard OIDC authorization-code
flow, mapped onto the existing `identities` table (a new `kind`, or a linked external-identity table —
design detail left to whoever picks this up once the IdP is known, since the right shape depends on
which). Per §1.2 / §3's addition, the acceptance check is a real login against the real chosen IdP, not
a mock.

**M4-6 — SSO/SCIM.** **[blocked: decision 1]** Depends on M4-5 landing first (SSO is OIDC login plus
org-level enforcement — "everyone in this org must use SSO" — which needs M4-2's org policy plane
too). SCIM provisioning/deprovisioning tested against the same real IdP chosen for M4-5, not a generic
SCIM test double.

**M4-7 — Org policy console.** Depends on M4-2 (org policy plane) existing server-side; no external
decision blocks this once M4-2 lands — it's UI work over an existing API, the same relationship M3-6's
candidate-set comparison view had to M3-2's backend. Per §1.1, do not build its fixtures against
pilot-scale arm-2 data; use the org policy plane's own test data.

**M4-8 — Managed Postgres + object store.** **[blocked: decision 2]** GCP Cloud SQL (Postgres) + GCS,
following the already-settled provider (`environments-plan.md` §5) — no new provider decision needed,
only a budget number. `docs/hosting-cost-estimate.md`'s pricing method (list rates, GCP `us-central1`,
re-verified before committing money) extends directly to these two services once sizing is known;
sizing depends on M4-3's storage-quota shape existing to bound it.

**M4-10 — Backup/PITR + executed drill.** **[blocked: decision 2, decision 3]** Hard dependency on
M4-8: GCP Cloud SQL's native PITR is the backup mechanism, not a bespoke one, so this item is mostly
*configuration and drill execution* once M4-8 is provisioned, not new engineering. The drill itself —
provision, corrupt or delete real data in a real (preview, not production) instance, restore, verify —
has to be actually run and its output kept as evidence, the same "executed, not asserted" standard M3
held its own benchmark arms to.

---

## 5. M4 exit criteria, restated

Per §3's clarification, all of these should be executable checks against a real preview instance, not
judgements:

1. **Org isolation is real.** Two organizations' repos, tokens, and policy are provably
   non-interfering — an org-scoped token from org A cannot read or write org B's repos, and org A's
   kill switch does not affect org B.
2. **A signup-to-workload path exists and was exercised**, against a preview instance the author
   controls access to (§3's reading of "external users can sign up") — an external identity, via the
   chosen IdP, creates an org, gets a token, and lands a real change.
3. **The restore drill was executed, not designed.** Real data, in a real (non-production) managed
   Postgres instance, deleted or corrupted, restored via PITR, verified against a known-good checksum
   or row count, with the drill's own record kept the same way `bench/runs/` keeps a benchmark's.
4. **The audit-log export reconciles with the operation log** — every row in an export matches a row
   `adp_history_query`/`adp_op_log` would return for the same filter, by construction (same table),
   proven by a test rather than asserted by the description.
5. **The runner isolates as designed**, not as hoped: a gate script that attempts a host-mount, an
   unbounded network call, or a resource-cap violation is refused or killed, and the refusal is itself
   recorded — the same "a skipped check must never look like a passing one" standard `CLAUDE.md`
   already holds the test suite to, applied to the thing the test suite is checking.
6. **Self-host actually works from nothing** — the `helm/` chart and the compose path both stand up a
   working instance on infrastructure the author does not control, the same bar
   `tools/win/Run-CleanTest.ps1` and `clean-room.yml` already hold the non-multi-tenant deploy to.
