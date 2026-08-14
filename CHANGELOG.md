# Changelog

The rule a version carries: the git tag, the GitHub release, the published
image (`ghcr.io/deduva/adp`), and the served `ADP-API-Version` all move
together — `vX.Y.Z` tags a commit whose `server/src/api-version.ts` says
`X.Y.Z`, and the release workflow refuses a tag that lies. What a bump
promises is defined in [`docs/api-compatibility.md`](docs/api-compatibility.md);
whether the operation set moved with the version is enforced by
`spec/operations.snapshot.json` and its spec-coverage guard.

## v0.3.0 — 2026-08-14

The coordinated breaking contract release (#97), plus the full M4
post-landing-audit remediation ([`docs/m4-postmortem-audit.md`](docs/m4-postmortem-audit.md),
tracked in #87) — every fix its own PR carrying the audit's named
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
