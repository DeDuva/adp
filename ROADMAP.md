# ADP — Roadmap

**This file is the repo's only status ledger.** A PR that completes, starts, pauses, or
supersedes a milestone updates this file in the same PR; anything shipped that changes
the contract or the capability surface gets a ledger row, milestone or not. Scope is
decided by the plan of record, [`docs/pragmatic_mvp.md`](docs/pragmatic_mvp.md) — this
file says where the project is, not how the next piece gets built.

## Mission

An unmodified, zero-config coding agent completes its entire outer loop — clone, read
the issue, push, PR, checks, review, merge — against this server instead of GitHub,
while every landed change is a signed transaction binding **intent → diff → evidence →
provenance**. The MVP definition of done is `docs/pragmatic_mvp.md` §2.1 and has been
enforced in CI since M1.

## Where this fits

ADP is the hub of a four-repo line of work: **adp-replay** pins the wire contract and
generates its client from `spec/openapi.yaml`; **squad-lab** records A/B tests as one
intent and N runs; **duva-bench** (both tracks) records every trial as a verified run.
The dependency map and what-breaks-what live in [`docs/ecosystem.md`](docs/ecosystem.md).

## Milestone ledger

**API contract version: `0.2.0`** (`server/src/api-version.ts`, served as
`ADP-API-Version` on every response). What a bump promises:
[`docs/api-compatibility.md`](docs/api-compatibility.md).

| Milestone | Status | Evidence / detail |
|---|---|---|
| M0 — walking skeleton | complete | PR #1. CI e2e: mint token → create repo → clone → push |
| M1 (a · b · b′ · c) — the MVP | complete 2026-08-01 | §2.1 gate enforced on every PR: real unmodified `gh` (`server/conformance/run.sh`) + the acceptance walkthrough (`server/acceptance/run.sh`). Narrative: `docs/pragmatic_mvp.md` Part 3 |
| M2 — adoption + trust ramp | complete 2026-08-03 | Mirror mode, outbound webhooks, `adp` CLI, telemetry, scanner-as-gate adapters, dependency admission v0, SBOM per land, Actions read-only passthrough. Verified scope: [`docs/m2-readiness-review.md`](docs/m2-readiness-review.md) |
| Runs / trajectories / eval-gated close *(capability slice)* | complete 2026-08-05 | PRs #58–#61 — took the wire contract 0.1.0 → 0.2.0. Driven by downstream consumers, not M3 scope. Detail: [`docs/trajectory-eval-slice.md`](docs/trajectory-eval-slice.md) |
| M3 — fleet + differentiation | complete 2026-08-10 | M3-0 … M3-6 landed (sequenced by [`docs/m3-readiness-review.md`](docs/m3-readiness-review.md)). All three benchmark arms published: [`bench/report/merge-contention.md`](bench/report/merge-contention.md) (arm 1, deterministic), [`bench/report/three-way-cost.md`](bench/report/three-way-cost.md) (arm 2, pilot scale), squad's duva-bench track (arm 3 — [squad PR #119](https://github.com/DeDuva/squad/pull/119)) |
| M4 — multi-tenant hosted preview | sequenced, not started | Work plan (M4-0 … M4-12) in [`docs/m4-readiness-review.md`](docs/m4-readiness-review.md). Blocked on three author decisions — see Blockers |
| M5 — substrate hardening | not started | Evidence-gated: every item requires a written justification citing M3/M4 telemetry |

## Now / Next / Later

- **Now:** nothing in flight. M3 is closed. M4 is sequenced (`docs/m4-readiness-review.md`) but
  Track A (org schema, tokens, policy plane, quotas/GC, audit export, runner, observability,
  self-host artifacts — M4-0…M4-4, M4-9, M4-11, M4-12) needs no decision to start.
- **Next:** the three M4 decisions below, then Track B (OIDC/SSO/SCIM, managed Postgres + object
  store, the backup/PITR drill).
- **Later:** M5 if and only if telemetry justifies each item.

## Blockers and open decisions

- **M4 decision 1 — identity provider.** OIDC login and SCIM (M4-5, M4-6) need one named IdP to
  build and test against; nothing here settles it. Blocks two work items, not the rest of M4.
- **M4 decision 2 — budget for managed Postgres + object store.** GCP Cloud SQL + GCS, following
  the already-settled cloud provider (`docs/environments-plan.md` §5) — this is a dollar number,
  not a provider choice. Blocks M4-8, and transitively M4-10 (the restore drill needs M4-8
  provisioned first).
- **M4 decision 3 — restore-drill timing.** Whether the backup/PITR drill runs against a real
  provisioned preview instance as soon as M4-8 lands, or is deferred until closer to the rest of
  M4 completing. Affects when M4-8's cost is incurred, not whether it is.
- **Issue #64 — native-plane response schemas.** The recording hot path is typed
  (PR #67); the remaining operations are frozen as guarded debt behind the
  `server/src/spec-coverage.test.ts` opt-out list, which must only shrink.

## Plan documents

- [`docs/pragmatic_mvp.md`](docs/pragmatic_mvp.md) — the plan of record: locked
  decisions, MVP definition, milestone narrative. Supersedes
  `docs/adp-prototype-implementation-plan.md` (the original 24-week prototype proposal,
  kept as history).
- [`docs/m2-readiness-review.md`](docs/m2-readiness-review.md) ·
  [`docs/m3-readiness-review.md`](docs/m3-readiness-review.md) ·
  [`docs/m4-readiness-review.md`](docs/m4-readiness-review.md) — what was actually
  verified entering each milestone; M3's and M4's carry the executable work plan.
- [`docs/trajectory-eval-slice.md`](docs/trajectory-eval-slice.md) — the 0.2.0
  capability slice.
- [`docs/ecosystem.md`](docs/ecosystem.md) — the cross-repo dependency map.
