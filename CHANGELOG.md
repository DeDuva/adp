# Changelog

The rule a version carries: the git tag, the GitHub release, the published
image (`ghcr.io/deduva/adp`), the Helm chart's `appVersion`, the workspace
package manifests, `spec/openapi.yaml`, the newest entry in this file, and the
served `ADP-API-Version` all move together — `vX.Y.Z` tags a commit whose
`server/src/api-version.ts` says `X.Y.Z`. `scripts/dev/check-release.sh`
asserts every one of those on each push, and the release workflow re-runs it
before publishing an image. What a bump promises is defined in
[`docs/api-compatibility.md`](docs/api-compatibility.md); whether the operation
set moved with the version is enforced by `spec/operations.snapshot.json` and
its spec-coverage guard.

Until 2026-08-23 only one edge of that rule was enforced, and it was checked on
the tag push — after publication. Two contract bumps slipped through it.

## v0.5.0 — 2026-08-23

Two contract moves reach a tag here. `0.4.0` was bumped in-tree when M4-5
landed and never tagged, released, or published as an image, so no consumer
could pin it; it ships inside this release rather than being retro-tagged, and
its entry is kept below verbatim. Both moves are additive — a client generated
against `0.3.0` is unaffected by either.

### 0.5.0 — the org storage quota

**M4-3: the per-org storage quota.** `orgs.max_storage_bytes` — the last of
the four org quotas, and the one the milestone never built. It was deferred to
M4-8 ("it needs the object store to meter against") while M4-8's own sizing was
deferred to it ("depends on M4-3's storage-quota shape existing to bound it"),
a deadlock that held for the whole milestone with nothing bounding how much one
org could write. It is broken from this side: the meter counts the bytes that
exist today — an org's rows in Postgres plus its git repos on disk — and gains
the object store as a third term the day there is one, without the ceiling's
shape changing.

Additive: `max_storage_bytes` joins the `PATCH /api/adp/orgs/{orgId}` body and
the `quotas` object on org detail. The latter is a wider shape than the three
counting quotas (`OrgStorageQuota`), because a measured `used` can be null and
carries the `measured_at` that says how stale it is.

Three behaviors worth knowing before setting a ceiling. **The meter is
sampled, not synchronous** — a ten-minute tick
(`STORAGE_METER_INTERVAL_MS`), because measuring is a full scan of the org's
rows in ten tables and cannot live on the trajectory hot path; that interval is
exactly the overshoot an org can achieve past its ceiling. **An org that has
never been metered is under quota, not over** — `storage_bytes_used` is null
until the first tick, and failing closed on null would refuse every write on
every instance for one interval after every restart. And **gate-job completion
is never refused**: the gate has already run, so refusing would wedge the job
until the reaper and leave its signed evidence unwritten, blocking any commit
under a `gates_green` policy — a storage quota turning into a land outage.
Instead the completion lands and its logs are dropped, with the drop recorded
on the operation so the empty `logs` reads as a decision rather than data loss.

Reads are never refused. An org at its ceiling can still clone what it already
has, because a quota that takes the data hostage is a lockout, not a ceiling.

New gauge: `adp_storage_bytes{org}`, the first storage metric this server has
had. `docs/observability.md` §5 amends its own "no per-org labels" position to
say why this one is the exception.

### 0.4.0 — OIDC login (shipped here, never separately released)

**M4-5: OIDC login (#103).** The standard authorization-code flow with PKCE,
mapped onto `identities` through a new `external_identities` table keyed on
`(issuer, subject)` — not on email, because Google's `sub` is the stable
identifier and an address that gets reassigned must not hand over an account.

Additive: two new operations, `GET /auth/oidc/start` and
`GET /auth/oidc/callback`. No existing operation changes shape, and both
routes are absent entirely on an instance with no IdP configured, so a client
generated against 0.3.0 keeps working untouched.

Two things worth knowing before enabling it. **Auto-provisioning is off by
default** — `OIDC_ALLOWED_DOMAINS` is empty, and empty means a verified
account with no existing link is refused rather than welcomed. And a login
mints `repo:read` + `repo:write` only; **`admin` is not reachable from the
login route by any input**, the same bound `POST /api/adp/tokens` carries.

ID tokens are verified against Node's own crypto rather than a JWT
dependency, with an allowlist of exactly one algorithm. The negative cases —
algorithm confusion, `alg: none`, unknown `kid`, tampered payload, wrong
issuer, wrong audience, expired, replayed nonce — are each a test, because
that is the only thing that makes the trade sound.

## v0.3.0 — 2026-08-14

The coordinated breaking contract release (#97), plus the full M4
post-landing-audit remediation (tracked in #87) — every fix its own PR carrying the audit's named
negative-case test.

**Security (P0).**
- Gate-job checkout/complete bind to the identity that claimed the job
  (#88) — previously any `runner` token could tarball any org's source and
  forge signed gate evidence.
- `repos(owner,name)` unique; `owner` validated against path traversal;
  `repos.org_id` NOT NULL and indexed (#89).
- `POST /api/adp/tokens` mints bounded tokens; `admin` no longer satisfies
  `runner` (#90).
- Org isolation enforced on every plane — REST, git http, GraphQL,
  `/api/adp` — with explicit, audited org provisioning and the
  org-isolation matrix test, M4 exit criterion #1 (#91).

**Queue reliability (P1a).**
- Claims are leases; a reaper requeues what a dead runner held, up to a
  retry cap, with operations recorded at every lifecycle transition, an
  `oldest_running_age` gauge, and an alert on the reaper itself (#92).
- `FOR UPDATE OF gate_jobs` — issue/PR numbering no longer starves the
  claim path (#93).
- All three org quotas enforce inside the transactions that consume them
  (#94). Completion and its signed evidence are one transaction (#95).
- Background writers (sweeper, reaper) take advisory locks — a second API
  replica is safe (#96).

**Contract (breaking).**
- `ADP-API-Version` 0.2.0 → 0.3.0, with an operation-set snapshot guard so
  the version can never silently not-move again.
- Every 4xx carries a shared `Error` schema; validation errors are a stable
  `{path, message, code}` projection, never raw validator internals.
- Auth and per-operation scopes declared in the spec (`x-required-scope`)
  and asserted against the code in both directions.
- Every list endpoint is bounded: `per_page`/`page` on the compat plane,
  `limit` + `ADP-Next-Cursor` keyset cursor on the native plane. The
  gate-jobs listing no longer inlines `logs`.
- Org administration (quota ceilings, policy repo, kill switch) has
  audited REST write paths, and org-level operations appear in the org
  audit-log export.
- The run/compare/verify/eval responses squad-lab consumes are typed.
- URLs keep `{owner}/{repo}`: the owner string is the org's immutable URL
  slug; org rename is unsupported pre-1.0 by design.

**Hardening & hygiene (P2).**
- Gate containers: `--cap-drop=ALL`, `--security-opt no-new-privileges`,
  `--pids-limit`, and a host-operator image allowlist
  (`RUNNER_IMAGE_ALLOWLIST`) (#100).
- The acceptance walkthrough runs in CI; `make runner` requires a real
  docker daemon; every self-skipping suite routes through the shared
  skip-into-failure guards (#99).
- `web/` runs tests in CI, with its hand-copied server enums bound to
  their sources (#98).
- This release identity itself: tag, GitHub release, published image with
  digest, `image:` in the compose file (#101).

## v0.2.0 — 2026-08-05

Runs carry `labels`; a compare row carries every named eval alongside the
single latest one. Additive.

## v0.1.0 — 2026-08-04

First versioned contract: runs, hash-chained trajectories, evals as gate
evidence.
