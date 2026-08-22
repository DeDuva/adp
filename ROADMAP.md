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

**API contract version: `0.5.0`** (`server/src/api-version.ts`, served as
`ADP-API-Version` on every response). Both moves since 0.3.0 are additive — M4-5's two OIDC login
operations at 0.4.0, and M4-3's `max_storage_bytes` on the org quota surface at 0.5.0; a client
generated against 0.3.0 is unaffected by either. What a bump promises:
[`docs/api-compatibility.md`](docs/api-compatibility.md). The debt the audit called out — eleven
operations landed additively during M4 under an unmoved 0.2.0 — was settled 2026-08-14 by the
coordinated 0.3.0 release (#97): version bumped WITH an operation-set snapshot guard so it can
never silently drift again, a shared Error schema, auth + per-operation scopes declared in the
spec and asserted against the code, every list endpoint bounded, audited org-administration
write paths, and typed responses for the four operations squad-lab reads.

| Milestone | Status | Evidence / detail |
|---|---|---|
| M0 — walking skeleton | complete | PR #1. CI e2e: mint token → create repo → clone → push |
| M1 (a · b · b′ · c) — the MVP | complete 2026-08-01 | §2.1 gate enforced on every PR: real unmodified `gh` (`server/conformance/run.sh`) + the acceptance walkthrough (`server/acceptance/run.sh`). Narrative: `docs/pragmatic_mvp.md` Part 3 |
| M2 — adoption + trust ramp | complete 2026-08-03 | Mirror mode, outbound webhooks, `adp` CLI, telemetry, scanner-as-gate adapters, dependency admission v0, SBOM per land, Actions read-only passthrough. Verified scope: [`docs/m2-readiness-review.md`](docs/m2-readiness-review.md) |
| Runs / trajectories / eval-gated close *(capability slice)* | complete 2026-08-05 | PRs #58–#61 — took the wire contract 0.1.0 → 0.2.0. Driven by downstream consumers, not M3 scope. Detail: [`docs/trajectory-eval-slice.md`](docs/trajectory-eval-slice.md) |
| M3 — fleet + differentiation | complete 2026-08-10 | M3-0 … M3-6 landed (sequenced by [`docs/m3-readiness-review.md`](docs/m3-readiness-review.md)). All three benchmark arms published: [`bench/report/merge-contention.md`](bench/report/merge-contention.md) (arm 1, deterministic), [`bench/report/three-way-cost.md`](bench/report/three-way-cost.md) (arm 2, pilot scale), squad's duva-bench track (arm 3 — [squad PR #119](https://github.com/DeDuva/squad/pull/119)) |
| M4 — multi-tenant foundations *(re-scoped 2026-08-22)* | complete 2026-08-22 | **Re-scoped to what can be finished without a spend decision**; the provisioned-infrastructure slice moved to its own row below. Landed: M4-0…M4-4 (org schema, org-scoped tokens, org policy plane, quotas/GC, audit-log export), M4-7 (org policy console), M4-9a…d (gate-job queue, `runner/` package, adp.yaml + gate_results, per-org caps), M4-11 (observability). The [`docs/m4-postmortem-audit.md`](docs/m4-postmortem-audit.md) (2026-08-13) found the code landed but the milestone not met; all four P0 fixes (#88–#91) landed with their negative-case proofs, including the **org-isolation matrix** (`server/test/e2e-org-isolation.test.ts`), as did the five P1a queue-reliability fixes (#92–#96) and all five P2 hygiene items (#98–#102, PRs #116–#120, closed 2026-08-14). M4-12 (self-host artifacts, PR #86) landed, satisfying exit criterion 6, M4-5 (Google OIDC login, #103) landed with it, and M4-3's storage quota — the half deferred to M4-8 while M4-8's own sizing waited on it — landed metered against what exists today rather than against the object store that does not. Exit criterion 4's reconciliation test landed (PR #127), comparing the audit export against the op log field for field in both directions, and criterion 5 was ratified in [`docs/m4-runner-isolation.md`](docs/m4-runner-isolation.md) (PR #128) — which needed two proofs that did not exist: that a gate container cannot reach the host filesystem or the Docker socket, and that a killed gate records signed *failure* evidence rather than a status flip nobody reads. **All four re-scoped exit criteria are now met** (1 org isolation, 4 audit reconciliation, 5 runner isolation, 6 self-host); criteria 2 and 3 moved to the hosted-preview row, since both need a provisioned instance and therefore a spend decision. Work plan: [`PLAN.md`](PLAN.md) |
| Hosted preview *(budget-gated slice, split out of M4 2026-08-22)* | blocked | M4-8 (managed Postgres + object store) and M4-10 (backup/PITR with an **executed** restore drill), plus the two M4 exit criteria that need a provisioned instance: signup-to-workload, and the executed drill. Blocked on decision 2 (budget) and decision 3 (drill timing) below — engineering is not the constraint, a dollar number is. Split out so M4 can close on what it delivered rather than stay open for a purchase order |
| 0.3.0 — contract breaking batch | complete 2026-08-14 | Shipped as one coordinated wire-contract release (#97 / PR #115, commit `5eb471d`, tag `v0.3.0`) while the only tokens in existence were hand-minted: version bumped with an operation-set snapshot guard against the C-1 vacuous pass, a shared `Error` schema, auth/scopes declared in the spec and asserted against the code, every list endpoint bounded, audited write paths for quota/policy-repo changes, and typed responses for the 4 operations squad-lab reads. **Kept `{owner}/{repo}` URLs** (gh fidelity requires them). Detail: [`docs/m4-postmortem-audit.md`](docs/m4-postmortem-audit.md) §"0.3.0 breaking batch" |
| M5 — substrate hardening | not started | Evidence-gated: every item requires a written justification citing M3/M4 telemetry |

## Now / Next / Later

- **Now:** the v6 reset (2026-08-22) — brief, plan and doc set rebuilt on the research in
  [`PLAN.md`](PLAN.md) Phase 0, which restores this ledger's accuracy and puts the freshness
  claims behind a gate (`scripts/check-docs.sh`) rather than behind habit. M4 remediation is
  complete through the 0.3.0 batch: all four P0s (#88–#91, with the exit-criterion-#1 isolation
  matrix), all five P1a queue-reliability fixes (#92–#96), the coordinated 0.3.0 contract release
  (#97), and all five P2 hygiene items (#98–#102) — each landed as its own PR carrying the
  audit's named negative-case test as proof.
- **Next:** with the re-scoped M4 closed, the serial-base-case forward work: author-independent
  approval (#121), compensating-revert undo, and the cross-harness resume demo. SCIM (M4-6)
  remains explicitly deferred.
- **Later:** the hosted-preview slice once decisions 2/3 are answered; M5 if and only if
  telemetry justifies each item.

## Blockers and open decisions

- **M4 decision 1 — identity provider. RESOLVED 2026-08-13: Google OIDC**, whose identities this
  project's users already have. **M4-5 landed 2026-08-22** (#103): authorization-code flow with
  PKCE, an `external_identities` link keyed on `(issuer, subject)`, auto-provisioning off by
  default, and a login that cannot mint `admin`. The real-Google acceptance procedure is in
  [`docs/self-hosting.md`](docs/self-hosting.md) §7 — the automated suite runs the full protocol
  against a real OpenID provider on localhost, which is what can be enforced per-push; Google
  specifically is a once-per-instance check. (Between 2026-08-13 and 2026-08-22 this row wrongly
  claimed the work was already "built and acceptance-tested against real Google"; it was not, and
  the claim had propagated to two other documents.) **SCIM (M4-6) is deferred**, not merely blocked — parked until
  a procurement conversation demands it, since SCIM against a real IdP is significant work with no
  current consumer.
- **M4 decision 2 — budget for managed Postgres + object store.** GCP Cloud SQL + GCS, following
  the already-settled cloud provider (`docs/environments-plan.md` §5) — this is a dollar number,
  not a provider choice. Blocks M4-8, and transitively M4-10 (the restore drill needs M4-8
  provisioned first). **Since 2026-08-22 it blocks only the hosted-preview row**, not M4: the
  milestone was re-scoped so this decision can be taken on its own timetable. It also gates the
  object-store split in the storage work, which is why the cheap in-Postgres fixes come first.
- **M4 decision 3 — restore-drill timing.** Whether the backup/PITR drill runs against a real
  provisioned preview instance as soon as M4-8 lands, or is deferred. Affects when M4-8's cost is
  incurred, not whether it is.
- **Issue #64 — native-plane response schemas.** The recording hot path is typed
  (PR #67); the remaining operations are frozen as guarded debt behind the
  `server/src/spec-coverage.test.ts` opt-out list, which must only shrink.
- **Narrative reweighting (2026-08-17, sharpened 2026-08-22): small-N concurrent is the base case;
  wide fan-out is a mode.** The public materials lead with one agent iterating to green and
  merging, with fan-out as the hard-problem/remediation mode. Two corrections landed with the v6
  reset. First, **the fan-out-vs-serial arm did run** — 2026-08-10, pre-registered, 20/20 trials
  verified, digest `cfebbb7d…`: fan-out cost 3.6× the tokens and wall clock and 2.8× the tool
  calls for acceptance scores inside the noise floor (`bench/README.md` arm 3). This row and the
  brief both previously said it had not, which understated the position; the real caveat is the
  one the arm's own report states — both tasks were single-pass-solvable, so it is a weak test of
  the case fan-out exists for. Second, **"serial" was too strong a word**: 79.4% of agent PRs are
  temporally co-active with another agent PR, with 19.8% intra-agent and 41.7% cross-agent
  conflict rates ([arXiv:2607.04697](https://arxiv.org/abs/2607.04697), 33,596 PRs), so the claim
  is small-N concurrency with one integrator and conventional CI, not serialism. Forward
  consequences, evidence-gated like everything else: author-independent approval (#121),
  compensating-revert undo, and the cross-harness resume demo. M5's speculative-batching gate
  stays closed — now because merge-queue batching adoption sits at 6%, not because conflicts are
  rare, which the co-activity data denies.

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
