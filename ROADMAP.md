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
[`docs/api-compatibility.md`](docs/api-compatibility.md). **Owed a bump to `0.3.0`:** eleven
operations landed additively during M4 without moving the version, and the
[`docs/m4-postmortem-audit.md`](docs/m4-postmortem-audit.md) batches them with a set of
deliberate breaking fixes into one coordinated 0.3.0 release — see the ledger row below.

| Milestone | Status | Evidence / detail |
|---|---|---|
| M0 — walking skeleton | complete | PR #1. CI e2e: mint token → create repo → clone → push |
| M1 (a · b · b′ · c) — the MVP | complete 2026-08-01 | §2.1 gate enforced on every PR: real unmodified `gh` (`server/conformance/run.sh`) + the acceptance walkthrough (`server/acceptance/run.sh`). Narrative: `docs/pragmatic_mvp.md` Part 3 |
| M2 — adoption + trust ramp | complete 2026-08-03 | Mirror mode, outbound webhooks, `adp` CLI, telemetry, scanner-as-gate adapters, dependency admission v0, SBOM per land, Actions read-only passthrough. Verified scope: [`docs/m2-readiness-review.md`](docs/m2-readiness-review.md) |
| Runs / trajectories / eval-gated close *(capability slice)* | complete 2026-08-05 | PRs #58–#61 — took the wire contract 0.1.0 → 0.2.0. Driven by downstream consumers, not M3 scope. Detail: [`docs/trajectory-eval-slice.md`](docs/trajectory-eval-slice.md) |
| M3 — fleet + differentiation | complete 2026-08-10 | M3-0 … M3-6 landed (sequenced by [`docs/m3-readiness-review.md`](docs/m3-readiness-review.md)). All three benchmark arms published: [`bench/report/merge-contention.md`](bench/report/merge-contention.md) (arm 1, deterministic), [`bench/report/three-way-cost.md`](bench/report/three-way-cost.md) (arm 2, pilot scale), squad's duva-bench track (arm 3 — [squad PR #119](https://github.com/DeDuva/squad/pull/119)) |
| M4 — multi-tenant hosted preview | in progress · **P0 remediation complete 2026-08-14 · P1a + 0.3.0 outstanding** | Work plan (M4-0 … M4-12) in [`docs/m4-readiness-review.md`](docs/m4-readiness-review.md). Track A code landed: M4-0…M4-4 (org schema, org-scoped tokens, org policy plane, quotas/GC, audit-log export), M4-9a…d (gate-job queue, `runner/` package, adp.yaml + gate_results, per-org caps), M4-11 (observability), M4-7 (org policy console). **The [`docs/m4-postmortem-audit.md`](docs/m4-postmortem-audit.md) (2026-08-13) found the code landed but the milestone not met.** All four P0 fixes have since landed, each with its negative-case proof: #88 gate-job checkout/complete ownership, #89 `repos(owner,name)` unique + `owner` validated + `org_id` NOT NULL/indexed, #90 bounded token minting + `admin ⊉ runner`, #91 org isolation on every plane — repo access authorizes against the caller's org everywhere (REST, git http, GraphQL, `/api/adp`), org provisioning is explicit and audited, and the **org-isolation matrix** (exit criterion #1, `server/test/e2e-org-isolation.test.ts`) now exists and passes. M4 stays open for the P1a queue-reliability fixes (#92–#96) and the 0.3.0 batch. M4-12 (self-host artifacts) unblocked and should describe the post-remediation shape |
| 0.3.0 — contract breaking batch | not started | Tracking: one coordinated wire-contract release taking the breaking fixes now, while the only tokens in existence are hand-minted. Bump the version (guarding against the C-1 vacuous pass), add an `Error` schema, declare auth/scopes in the spec, bound every list endpoint, add audited write paths for quota/policy-repo changes, and type the 4 responses squad-lab reads. **Keeps `{owner}/{repo}` URLs** (gh fidelity requires them). Detail: [`docs/m4-postmortem-audit.md`](docs/m4-postmortem-audit.md) §"0.3.0 breaking batch" |
| M5 — substrate hardening | not started | Evidence-gated: every item requires a written justification citing M3/M4 telemetry |

## Now / Next / Later

- **Now:** **M4 P1a queue reliability** — the P0 sequence from the
  [`docs/m4-postmortem-audit.md`](docs/m4-postmortem-audit.md) completed 2026-08-14 (#88 gate-job
  ownership, #89 repos uniqueness/validation, #90 bounded token minting, #91 org isolation with
  the exit-criterion-#1 matrix test), each landed as its own PR carrying the audit's named
  negative-case test as proof. What remains before M4 can close: the P1a queue-reliability fixes
  (#92 lease/requeue + claim op, #93 `of: gateJobs`, #94 quota TOCTOU, #95 atomic
  completion+evidence, #96 sweeper leader guard).
- **Next:** the **0.3.0 breaking batch** (one coordinated release — see the ledger row and the
  audit's contract section), then M4-5 (Google OIDC — decision 1 resolved below), then M4-12
  (self-host artifacts, describing the post-remediation shape), then the rest of Track B behind
  decisions 2/3. SCIM (M4-6) is explicitly deferred.
- **Later:** M5 if and only if telemetry justifies each item.

## Blockers and open decisions

- **M4 decision 1 — identity provider. RESOLVED 2026-08-13: Google OIDC.** M4-5 (OIDC login) is
  built and acceptance-tested against real Google, whose identities this project's users already
  have. **SCIM (M4-6) is deferred**, not merely blocked — it is parked until a procurement
  conversation demands it, since SCIM against a real IdP is significant work with no current
  consumer.
- **M4 P0/P1 — from the post-landing audit** ([`docs/m4-postmortem-audit.md`](docs/m4-postmortem-audit.md)).
  Not author decisions but the gating work: the milestone does not close until the P0 fixes land
  with the isolation-matrix test. Tracked as GitHub issues.
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
- [`docs/m4-postmortem-audit.md`](docs/m4-postmortem-audit.md) — what was actually *delivered*
  when M4's code landed: the P0/P1/P2 findings, the 0.3.0 batch, and the four decisions of
  2026-08-13 (no hosted staging, `{owner}/{repo}` kept, Google OIDC, SCIM deferred).
- [`docs/trajectory-eval-slice.md`](docs/trajectory-eval-slice.md) — the 0.2.0
  capability slice.
- [`docs/observability.md`](docs/observability.md) — M4-11: what is measured, what pages,
  and what to do when it does.
- [`docs/ecosystem.md`](docs/ecosystem.md) — the cross-repo dependency map.
