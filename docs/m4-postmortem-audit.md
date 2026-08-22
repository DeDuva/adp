# M4 post-landing audit

*2026-08-13 · A tech-lead review of everything that landed on `main` over 2026-08-10/11 —
the eleven M4 slices — read against the standard the [`m4-readiness-review.md`](m4-readiness-review.md)
set for the milestone before it started. Companion to that review (which specified the work) and to
[`ecosystem.md`](ecosystem.md) (who now depends on the result). Amends
[`ROADMAP.md`](../ROADMAP.md), [`pragmatic_mvp.md`](pragmatic_mvp.md) and
[`environments-plan.md`](environments-plan.md); those amendments are recorded in the same change as
this file.*

## Why this review exists, and why now

M3 was self-contained engineering, fundable and verifiable against a local dev instance. M4 is the
first milestone whose output other people build on: `adp-replay`, `squad-lab`, and `duva-bench` all
read this server's wire contract, and two of them re-read runs from it rather than from local state
(`ecosystem.md` §3). The cost of a wrong contract or a broken tenancy boundary stopped being local
the day those consumers appeared.

The eleven slices landed with a green `make check` on every PR. That is exactly the problem this
review documents: **the test suite measures the surface that works.** The multi-tenant boundary M4
exists to create is enforced on four of roughly ninety-eight operations; the gate-job queue has no
way to recover a job whose runner died; the runner's least-privileged token type cannot be minted as
anything but `admin`; and eleven new operations shipped under an unchanged contract version. None of
that is visible from the exit code, because no test asserts the negative — that org A is *refused* on
org B, that a dead runner's job is *reclaimed*, that an `admin` token is *rejected* where only a
runner should reach.

The milestone's own exit criteria (`m4-readiness-review.md` §5) already name the missing tests. This
review confirms they are still missing and turns them into a remediation plan. The disposition is
below; the standard applied is the same one `CLAUDE.md` states: *a skipped check must never look like
a passing one*, generalized here to *an unenforced boundary must never look like an enforced one*.

The findings are severity-ranked. P0 is security or correctness that must be fixed before anyone is
told to point at a shared instance. P1 is reliability and contract debt that bites a persistent
instance under real load, batched into one breaking release (0.3.0) taken deliberately now, while the
only tokens in existence are a handful of hand-minted ones. P2 is quality and deploy hygiene.

---

## P0 — security / correctness

### P0-1. Org isolation is not enforced on the data plane

`requireOrgAccess` (`server/src/auth/plugin.ts:83`) is correct and fails closed — it checks both the
token's own `orgId` and live membership, so a revoked membership takes effect immediately. It is
wired into exactly four routes: three in `http-rest/orgs.ts` (`:120,:159,:221`) and one in
`http-rest/audit-log.ts:43`. A grep across `server/src` finds it nowhere else.

Every repo-scoped surface is therefore org-blind:

- `GET /api/v3/repos/:owner/:repo` (`http-rest/repos.ts:154`) and the rest of the compat plane —
  issues, proposals, `PUT .../merge`, `POST .../undo` — gate on `requireScope` only.
- Git clone/push: `http-git/proxy.ts:204` checks `hasScope`, and `proxy.ts:191` resolves the repo off
  the **filesystem**, so it never sees an `org_id` at all.
- The entire GraphQL plane: `http-gql/route.ts:71` gates on `hasScope(identity.scopes, "repo:read")`.
- All `/api/adp` repo routes (workspaces, candidate-sets, runs, sessions, operations, gates).

**Consequence:** an org-A token reads, writes, clones, pushes to, merges into, and undoes operations
on org-B repos. The tenancy boundary M4-0 exists to create does not exist outside the four
org-metadata routes. Every route listed is pre-M4 and never received the check.

*Fix (P0, largest):* add org resolution (via `repos.org_id`) + `requireOrgAccess` to every
repo-scoped route across all planes; add the e2e **isolation matrix** test named in
`m4-readiness-review.md` §5.1 — org A refused on org B via `/api/v3`, git http, GraphQL, `/api/adp`.
Depends on P0-6's `repos.org_id` becoming `NOT NULL`.

### P0-2. Repo-create silently creates orgs and escapes quotas

`http-rest/repos.ts:33` calls `findOrCreateOrg(db, owner)`; `core/org-lookup.ts:11` inserts a new
`orgs` row when the owner string is unseen. None of the three create routes (`repos.ts:88,:112,:133`)
checks membership on the target org.

**Consequence, both present today:** (a) any `repo:write` token creates repos in any named org,
becoming its first owner; (b) the per-org `maxRepos` quota (`repos.ts:34-40`) is trivially bypassed —
hit the cap, POST under a fresh owner string, get a new unlimited org.

*Fix (P0):* on the create path, creating in an org you are not a member of is a 403;
`findOrCreateOrg` stops creating on that path. Provisioning a new org becomes an explicit, audited
action, not a side effect of naming one.

### P0-3. Gate-job checkout and complete are unowned

`http-rest/gate-jobs.ts:170` (checkout) and `:192` (complete) check only that the job's status is
`running` (`:177,:209`) — never that the caller is the runner that claimed it. There is no `claimedBy`
comparison, despite the comments at `:76-80` and `:165-169` asserting the runner "only ever reads the
one repo/sha of a job it has actually claimed."

**Consequence:** any token with the `runner` scope can poll job ids and pull a tarball of any org's
source (`:188`), and can `complete` any org's job with `{"status":"succeeded"}`. Completion writes a
**signed `gate_results` row** (`:249`) that `gates_green` accepts (`core/land-policy.ts:114`) — a
land-policy bypass reachable from the least-privileged token type in the system, across tenants. The
precision of the comments is the tell: they are falsifiable, and false.

*Fix (P0, smallest, largest delta):* add the `claimedBy` comparison to both routes; correct the two
comments in code rather than softening them. Test: a runner token cannot checkout/complete a job a
different `claimed_by` holds.

### P0-4. No runner-scoped token can be minted, and `admin` satisfies `runner`

`mintToken`'s only non-test caller is `bootstrap.ts:45`, which always mints
`["repo:read","repo:write","admin"]`. No REST route mints tokens at all. And `auth/plugin.ts:52` —
`admin` short-circuits every scope check, including `runner`.

**Consequence:** everything the runner's package boundary is designed to guarantee (no `server/`
import, no `DATABASE_URL`, no `SIGNING_KEY` — all asserted in `runner/src/config.test.ts:24`) is
undeliverable with shipped tooling, because a real deployment hands the untrusted-code host an
`admin` token — one that can throw an org kill switch, read every repo, and complete every gate.
Compounding: `deploy/docker-compose.yml` has no runner service, so there is no deployment path at all,
despite `ROADMAP.md` calling M4-9 complete.

*Fix (P0):* a `POST /api/adp/tokens` (admin + org-scoped) minting a bounded scope set; remove the
`admin ⊇ runner` short-circuit (keep `admin` over the CRUD scopes). Test: an `admin` token is refused
on checkout; a freshly-minted `runner` token is accepted.

### P0-5. `owner` is unvalidated and reaches `path.join`

`repos.ts:13` regex-validates `name`; nothing validates `owner` anywhere. `core/git-backend.ts:146`
is `path.join(this.gitRoot, owner, \`${name}.git\`)`. find-my-way decodes `%2F` into path params, so
`POST /api/v3/repos/..%2F..%2Ftmp%2Fx` yields `owner = "../../tmp/x"` → `git init --bare` outside
`GIT_ROOT`, plus an `orgs` row named `../../tmp/x`. Pre-M1, but `owner` is now the tenancy key and the
org name.

*Fix (P0):* reuse the `name` regex for `owner`. Bundled with P0-6 (same migration/PR).

### P0-6. `repos` has no unique index on `(owner, name)`

Confirmed absent across all 24 migrations. `repos.ts:46-47` checks existence outside the insert
transaction, so two concurrent creates produce two rows for one on-disk repo; `findRepo`
(`core/repos-lookup.ts:5`) then picks one nondeterministically, splitting issues, gate-jobs, and org
assignment between two IDs for one repo. It is also the single hottest query in the server, currently
a sequential scan.

*Fix (P0):* one migration — unique index on `(owner, name)`, plus an index on `repos(org_id)` (a
Postgres FK creates none, and `org_id` is in the claim hot path, the audit export, and all three
quota counts). Move the existence check inside the insert transaction and rely on the constraint.

---

## P1 — reliability

### P1-1. The gate-job queue has no lease, timeout, or requeue

`core/gate-jobs.ts:92-96` sets a claimed job to `running` and sets `startedAt`; nothing ever revisits
it. `pg-boss` — named as the intended mechanism in `pragmatic_mvp.md` §4 and `m4-readiness-review.md`
§4 (M4-3, M4-9) — was not used; the queue is bespoke, and the three things pg-boss gives for free
(leases/expiry, retries, singleton scheduling) are exactly the three missing.

**Consequence:** a runner that dies after claiming leaves the job `running` forever, with three
compounding effects: (a) the gate never reports, so `gates_green` blocks that commit's land
permanently; (b) the job permanently consumes one slot of the org's `maxConcurrentGateJobs`
(`gate-jobs.ts:79-82`), so an org can deadlock its own queue; (c) `complete` now 409s (`:209`), so
there is no recovery short of psql. The `oldest_queued_age` alert (`infra/dev/monitoring.tf`) only
watches *queued* jobs, so a wedged `running` job is invisible on the dashboard. The e2e suite even
institutionalizes the gap — `test/e2e-gate-job-quotas.test.ts:118-124` deliberately leaves foreign
jobs `running` forever, describing a production defect as test infrastructure.

*Fix (P1):* a lease (`lease_expires_at`, or `started_at` + a timeout) and a reaper — the same
sweeper mechanism as the workspace sweeper — that requeues expired jobs up to a retry cap, then marks
them `error` with a recorded operation. Add an `oldest_running_age` metric + alert.

### P1-2. `FOR UPDATE` with no `OF` locks the joined `repos` row

`core/gate-jobs.ts:89` is `.for("update", { skipLocked: true })` over a query that joins `repos`
(`:68`). Drizzle emits `for update` with no `OF` clause unless `of` is passed, and Postgres then locks
rows in **all** tables in the FROM. Issue and PR number assignment (`http-rest/issues.ts:66`,
`proposals.ts:119`) both do `select id from repos where id = ? for update` to serialize numbering.
While either is held, claim's `SKIP LOCKED` skips every queued job for that repo — so creating an
issue starves that repo's gate queue, and vice versa.

*Fix (P1, one argument):* `of: gateJobs` on the claim lock.

### P1-3. All three quota checks are TOCTOU; the concurrency cap is racy

Repo (`repos.ts:34-40`), workspace (`core/workspaces.ts:32-47`), and gate-job counts are each
evaluated outside the transaction that inserts. `SKIP LOCKED` prevents two runners taking the same
*row*, not the same *budget*: two concurrent claims both see `count = cap - 1`, both pass, both claim.
Every one of the three "hard ceilings" is exceedable by concurrent requests, and all three tests are
sequential, so none of the races is covered.

*Fix (P1):* evaluate the count inside the mutating transaction, or express the cap as a selection
condition already holding the relevant lock. Add a concurrency test per quota.

### P1-4. Job completion and its evidence are two transactions

`http-rest/gate-jobs.ts:214-235` writes the job status + `gate_job.complete` operation atomically
(good), but `recordGateResult` at `:249` opens its own transaction (`core/gate-results.ts:53`). A
crash between them leaves a terminal job with no evidence and no re-drive path (`:209` refuses).

*Fix (P1):* fold the evidence write into the completion transaction, honoring the repo's
"operation log in the same transaction as the change" invariant fully rather than in the weak sense.

### P1-5. Claim writes no operation row

`core/gate-jobs.ts:92-96` — enqueue records an operation (`:38`) and complete records one
(`gate-jobs.ts:226`), but claim, the transition that assigns a named runner to a job, records
nothing. It is the one lifecycle event an incident review needs and the only one absent from the log.

*Fix (P1):* record an operation on claim, inside the claim transaction.

### P1-6. The workspace sweeper assumes a single instance

`core/workspace-sweeper.ts` runs on `setInterval`, started unconditionally in every process
(`main.ts:119`), default 5 minutes. Two replicas both sweep; `FOR UPDATE SKIP LOCKED` prevents two
ticks grabbing the same row inside one transaction, but the losers still count as `failed`
(`workspace-sweeper.ts:48`), so replica count inflates the failure signal, and each does a redundant
`git update-ref -d`. No advisory lock, no leader election. Throughput is also capped at 600
workspaces/hr (`BATCH_SIZE = 50` × 5-minute interval), so a large expiry backlog keeps an org over its
own live-workspace quota for hours.

*Fix (P1, cheap):* a Postgres advisory lock (or leader guard) around the sweep and the metrics
sampler, so a second replica is safe — which also unblocks horizontal read scaling later.

### P1-7. Queue mechanism: a decision to record, not necessarily reverse

The queue and sweeper are bespoke where `pg-boss` was named. The recommendation is to **keep the
bespoke queue** — it is small and the P1-1…P1-6 fixes are cheap — but to write that down as a
decision rather than leave it as an omission, so the next person doesn't rediscover the gap and assume
it was never considered. If a fleet-scale runner pool later needs `LISTEN/NOTIFY` and real retry
backoff, revisit then, with the poll-load numbers P1's telemetry will have produced.

---

## P1 — contract (the 0.3.0 breaking batch)

Bundle every breaking contract change into one version bump so consumers regenerate once. The batch
**keeps `{owner}/{repo}` URLs** (decision, 2026-08-13): `gh` fidelity requires owner-shaped URLs, so
the owner string becomes the org's immutable URL slug and org rename stays unsupported pre-1.0. This
constrains the `repos.owner`-vs-`repos.org_id` duplication rather than decoupling it.

### C-1. Eleven new operations shipped under an unchanged `0.2.0`

`spec/openapi.yaml` gained +11 operations, −0, since `API_VERSION` last moved (2026-08-05); both were
left at `0.2.0` together, so `server/src/api-version.test.ts:36-38` (which only asserts spec ==
constant) passes vacuously while `docs/api-compatibility.md`'s own rule ("new endpoint → minor") is
broken. adp-replay asserts `ADP-API-Version` at startup and is generated against `0.1.0` already; its
drift check compares the vendored spec to the *pinned* ADP ref — a tautology that cannot fail
(`ecosystem.md` §"adp → adp-replay").

*Fix:* bump to `0.3.0`; add a guard that fails when the set of spec operations changes without
`info.version` moving (extend `spec-coverage.test.ts`, which already enumerates the route table).

### C-2. The rest of the batch

- **Two identifier types for "org"** — `/api/v3/orgs/{org}` keys by name string,
  `/api/adp/orgs/{orgId}` by uuid, unlinked. Unify or document the mapping as contract.
- **`components/schemas/Error`** — 168 error sends use `{message}`, 20 also attach
  `errors: parsed.error.issues` (raw Zod issue objects), and none is documented. This pins the wire
  format to Zod's internal shape: a Zod v3→v4 bump becomes a silent major break. Define the schema and
  reference it from every 401/403/404/409/422.
- **Auth in the contract** — 8 authenticated GETs are marked anonymous in the spec (no `security:`
  block while the route is `requireScope("repo:read")`); 82 secured operations can 403 but only 4
  document it and 0 document 401; scopes appear only in prose. Declare 401/403 on secured operations,
  declare scopes per operation (scoped security scheme or `x-adp-scope`), and extend
  `spec-coverage.test.ts` to assert spec-security ⇔ `requireScope`. That one test closes the
  anonymous-GET and undocumented-403 classes for good.
- **Unbounded list endpoints** — issues, comments, reviews, hooks, workspaces, candidate-sets, and
  session checkpoints have no cap; `GET /api/adp/.../gate-jobs` silently truncates at 200 with no
  cursor **and returns inline `logs`** (up to ~200 MB). Add a `limit` cap + keyset cursor to the
  native lists, `per_page` to the compat lists, and drop `logs` from the gate-jobs list projection
  (fetch via a detail route). Adding a cap after runners depend on the unbounded shape is worse.
- **Write paths for quota and policy-repo changes** — changing an org's quota or designating its
  policy repo is an unaudited psql UPDATE today; `orgs.ts` accepts only `kill_switch`. And the
  kill-switch operation records `repoId:null` (`orgs.ts:251`), so the audit export — which filters by
  repoId — never shows the single most consequential org action. Give both a route, both audited, and
  make the kill-switch op carry the org.
- **Chip at issue #64** — type the 4 responses squad-lab actually reads (`runs/compare`,
  `runs/{runId}/verify`, `runs/{runId}/evals`, `runs`) as part of this batch. The
  `RESPONSE_SCHEMA_DEBT` list may only shrink; the remaining 25 stay frozen debt.

Coordinate with adp-replay: bump `ADP_REF`, `make sync-spec && make generate`, and fix its
tautological drift check to compare its pin against the served `ADP-API-Version`.

---

## P2 — quality / deploy hygiene

- **`web/` builds but is not tested in CI**, which is why `OrgConsole` renders a `gates_confident`
  policy as blank: `web/src/api.ts:153` hand-copies a server enum and omits the third member, and the
  console indexes a `Record<LandRequirement,string>` over it. The case that fires is the malformed-
  policy fail-closed path — the exact case the console has a dedicated red banner for — so the console
  tells the operator "every requirement is enforced" and renders one of them invisibly. Fix the enum
  and add a coverage test binding it to the server enum, in the `observability-coverage.test.ts`
  style.
- **The acceptance tier never runs in CI.** `server/acceptance/run.sh` is the only thing asserting the
  §2.1 `gh pr checks` gap is actually closed, and `.github/workflows/ci.yml` has no acceptance job — it
  runs only via `make check`. The headline exit criterion is protected by a human typing a command.
- **`make runner` omits `ADP_REQUIRE_DOCKER`**, so `make check` runs the runner package but silently
  skips the real-container isolation tier — the exact failure `require-docker.ts` exists to prevent.
  (CI sets the flag; the Makefile does not.) Four suites also bypass the shared `require-db` gate with
  a raw env check.
- **Runner container hardening.** `runner/src/docker.ts:61-80` correctly has `--network none`,
  `--memory`, `--cpus`, no mounts, no docker.sock — and proves `--network none` against a real daemon
  (`docker.test.ts:87`), which is exemplary. Missing: `--pids-limit`, `--read-only`+`--tmpfs`, a
  storage cap, `--user` (jobs run as root in-container), `--cap-drop=ALL`,
  `--security-opt=no-new-privileges`. And the gate **image is repo-controlled and unconstrained**
  (`core/repo-policy.ts:52` → `docker create`): any pushed `adp.yaml` pulls and runs an arbitrary
  registry image on the runner host. Add the flags and an image allowlist / digest pin.
- **No release identity.** Zero git tags, zero GitHub releases, no CHANGELOG, no published image;
  `deploy/docker-compose.yml` builds from source with no `image:` tag; the Artifact Registry `adp`
  repo and the CI OIDC federation are provisioned and unused. A consumer can pin only a raw SHA. This
  is the concrete deliverable of the "no hosted staging" decision (see `environments-plan.md`): the
  pinnable artifact *is* the separation mechanism.
- **Signing-key trust model unfinished for multiple keys.** `verifyEnvelope` resolves against a single
  passed-in signer, not `keyid` through a registry, so a retired key's evidence fails verification —
  which any second environment or key rotation would surface. And `SIGNING_KEY` is co-resident with
  the runner on the dev box, a rule `environments-plan.md` states as safe only "because no executor
  exists" — no longer true now that M4-9 shipped the executor.

---

## Calibration — what is genuinely well done

So the audit is not read as uniformly negative: the milestone contains the best test in the repo and
several correct-on-the-first-try decisions.

- **`server/src/observability-coverage.test.ts`** — binds the metric families to the real Terraform
  and dashboard JSON in *both* directions (infra names a metric the server doesn't export → fail;
  server exports one nothing watches → fail), checks the declared type not just the name, guards its
  own regex against vacuous passing, and asserts every alert policy has a notification channel. It
  generalizes "a skipped test must never look like a passing one" to "an empty chart must never look
  like a healthy one."
- **The self-skip gates.** `runner/test/require-docker.ts` mirrors `require-db.ts` exactly — skip by
  default, loud banner, hard throw under `ADP_REQUIRE_DOCKER=1` — and CI wires it in unconditionally,
  a new skippable tier getting the guard on the first try.
- **`runner/src/docker.test.ts:87`** proves isolation against a real daemon rather than asserting on
  an argument array — the whole value of the tier.
- **The runner's package boundary** — no `server/` import, no DB or signing credential, with
  `config.test.ts:24` asserting the *absence*. (Undermined operationally by P0-4, not by the design.)
- **Token storage** (`auth/tokens.ts`) — scrypt with a per-token salt and `timingSafeEqual`, with an
  indexed `sha256` lookup key used only to narrow the row scan, and a comment saying so.
- **`requireOrgAccess` fails closed correctly** — token org *and* live membership, so a revoked
  membership revokes access immediately rather than at next mint. (The problem is where it is *not*
  applied, P0-1, not how it behaves.)
- **Org policy as a signed file-in-repo**, and the deliberate refusal to add a "save policy" button
  (`orgs.ts:22-29`): "a second, unsigned way to change the same thing, and the weaker one would win
  every time it was more convenient." Correct, and correctly resisted.
- **`OrgPolicySource`** (`core/org-policy.ts:38`) distinguishes "deliberately requires everything"
  from "your file is broken and you are being failed closed," because the two produce an identical
  policy — surfaced in the console with a real explanation.
- **Migration `0018`'s backfill** — idempotent by construction (`ON CONFLICT DO NOTHING` + an
  `org_id IS NULL` guard on the UPDATE), with the reasoning in the SQL.

---

## Disposition

| ID | Finding | Severity | Batch |
|---|---|---|---|
| P0-1 | Org isolation unenforced on the data plane | critical | P0 |
| P0-2 | Repo-create creates orgs / escapes quota | critical | P0 |
| P0-3 | Gate-job checkout/complete unowned | critical | P0 |
| P0-4 | No runner token; `admin ⊇ runner` | critical | P0 |
| P0-5 | `owner` unvalidated → path traversal | major | P0 (with P0-6) |
| P0-6 | No unique index on `repos(owner,name)` | major | P0 |
| P1-1 | Queue: no lease / requeue | major | P1a |
| P1-2 | `FOR UPDATE` without `OF` | major | P1a |
| P1-3 | Quota checks TOCTOU | major | P1a |
| P1-4 | Completion + evidence not atomic | major | P1a |
| P1-5 | Claim writes no operation | major | P1a |
| P1-6 | Sweeper assumes single instance | major | P1a |
| P1-7 | Queue mechanism decision unrecorded | minor | P1a |
| C-1 | 11 ops under unchanged `0.2.0` | major | 0.3.0 |
| C-2 | Error schema / auth-in-spec / pagination / write paths / #64 | major | 0.3.0 |
| P2-* | web CI, acceptance in CI, runner make flag, container hardening, release identity, key registry | mixed | P2 |

The sequencing, the four decisions taken 2026-08-13 (no hosted staging; 0.3.0 keeps `{owner}/{repo}`;
Google OIDC with SCIM deferred; docs+issues this pass), and the per-item fixes are in the executable
plan this review accompanies. Each P0/P1 fix lands as its own PR carrying the negative-case test named
above as its proof — starting with the org isolation matrix, which is M4 exit criterion #1 and does
not exist today.
