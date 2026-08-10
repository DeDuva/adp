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
| M3 — fleet + differentiation | in progress | M3-0 … M3-6 all landed (sequenced by [`docs/m3-readiness-review.md`](docs/m3-readiness-review.md)). **Remaining: M3-5 arms 2 and 3 — and nothing else.** Arm 1 is run and published: [`bench/report/merge-contention.md`](bench/report/merge-contention.md) |
| M4 — multi-tenant hosted preview | not started | |
| M5 — substrate hardening | not started | Evidence-gated: every item requires a written justification citing M3/M4 telemetry |

## Now / Next / Later

- **Now:** nothing in flight. M3 is open on its two agent-backed benchmark arms only.
- **Next:** M3-5 **arm 3** (fan-out vs serial) — duva-bench's squad track already runs
  topology (single vs swarm) as an experimental axis recording into ADP, so this is a
  study YAML away once budget is approved. Then **arm 2** (agent-backed three-way cost
  comparison), which additionally needs a real GitHub repo and PAT.
- **Later:** M4, then M5 if and only if telemetry justifies each item.

## Blockers and open decisions

- **Budget for M3-5 arms 2–3** — a decision, not an access problem. Verified 2026-08-08:
  working Anthropic and Gemini keys sit at `~/.config/squad/` and sibling projects spent
  through them all week (calibration: a 24-trial pilot cost $8.03; an 80-run study ~$28).
  The one outstanding input is a budget number from the author.
- **Issue #64 — native-plane response schemas.** The recording hot path is typed
  (PR #67); the remaining operations are frozen as guarded debt behind the
  `server/src/spec-coverage.test.ts` opt-out list, which must only shrink.

## Plan documents

- [`docs/pragmatic_mvp.md`](docs/pragmatic_mvp.md) — the plan of record: locked
  decisions, MVP definition, milestone narrative. Supersedes
  `docs/adp-prototype-implementation-plan.md` (the original 24-week prototype proposal,
  kept as history).
- [`docs/m2-readiness-review.md`](docs/m2-readiness-review.md) ·
  [`docs/m3-readiness-review.md`](docs/m3-readiness-review.md) — what was actually
  verified entering each milestone; M3's carries the executable work plan (M3-0 … M3-6).
- [`docs/trajectory-eval-slice.md`](docs/trajectory-eval-slice.md) — the 0.2.0
  capability slice.
- [`docs/ecosystem.md`](docs/ecosystem.md) — the cross-repo dependency map.
