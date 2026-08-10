# The ADP ecosystem — who depends on what

**Written 2026-08-08.** ADP now has downstream consumers, and the coupling between them
is real: a change to ADP's wire contract has broken, or silently failed to reach, code in
three other repositories. Until this document existed, that dependency graph was written
down nowhere — the only record of it was in the heads of the people and agents who built
it, which is not a record.

This page is a map, not a plan. Each project's own plan of record is linked below.

---

## 1. The four repositories

| Repo | Purpose | Where it is |
|---|---|---|
| **adp** (this repo) | The agent-native VCS and verification substrate. Records runs, trajectories and attested evals; serves a GitHub-compatible plane and a native plane. | [`DeDuva/adp`](https://github.com/DeDuva/adp) — public |
| **adp-replay** | Records agent trajectories on closed-world coding tasks and replays them under substituted models, producing evidence-gated verdicts about model performance. ADP's first external consumer. | [`DeDuva/adp-replay`](https://github.com/DeDuva/adp-replay) — public |
| **squad** (fork) | Multi-agent dev-team orchestrator. Hosts two packages that matter here: `packages/squad-lab` (goal-setting and cross-provider A/B testing) and `packages/duva-bench` (the squad track of duva-bench). | [`DeDuva/squad`](https://github.com/DeDuva/squad) — default branch **`dev`** |
| **duva-bench** | Controlled factorial experiments on coding agents. Two deliberately parallel tracks — a **squad** track (in the fork above) and a **Harbor** track (its own repo). | [`DeDuva/duva-bench`](https://github.com/DeDuva/duva-bench) — public |

A fifth repository, **duva-lab-tpm** (private), holds the programme-management record:
the cross-project audit and squad-lab's milestone reports. It has no code and nothing
depends on it.

---

## 2. The dependency graph

```
                    ┌─────────────┐
                    │     adp     │  wire contract, currently 0.2.0
                    └──────┬──────┘
             REST /        │ runs, labels,      \ REST
      versioned contract   │ evals, verify       \
                    ┌──────┴──────┐         ┌─────┴──────┐
                    │ adp-replay  │         │ squad-lab  │
                    └──────┬──────┘         └─────┬──────┘
                           │ stats library        │ package deps
                    ┌──────┴──────────────────────┴──────┐
                    │            duva-bench              │
                    │   squad track  ‖  Harbor track     │
                    └────────────────────────────────────┘
                          shared task triples + shared statistics
```

### adp → adp-replay — a *pinned* wire contract

The only coupling in this graph that is version-pinned, and the one most likely to
surprise someone.

| Thing | Where |
|---|---|
| Pinned ADP revision | `adp-replay/.github/workflows/ci.yml`, `ADP_REF` |
| Vendored spec | `adp-replay/spec/adp-openapi.json` |
| Version assertion at startup | `adp-replay/src/adp_replay/adp/version.py` |
| Generated client | `adp-replay/src/adp_replay/adp/_generated/` |

adp-replay generates its client from ADP's `spec/openapi.yaml` and asserts the served
`ADP-API-Version` at startup, failing loudly rather than mid-experiment.

> **Watch out.** adp-replay's CI checks its vendored spec against **the pinned ADP ref**,
> not against ADP's `main`. That check is a tautology — it cannot fail, and nothing in
> either repo moves the pin. As of 2026-08-08 adp-replay is generated against **0.1.0**
> while this repo serves **0.2.0**. The drift is benign (0.2.0 is additive) but it is
> unmonitored.

### adp → squad-lab — runs, labels and evals

squad-lab treats **an A/B test as one ADP intent and N ADP runs**, and stores nothing ADP
can answer. It consumes:

- `POST /api/adp/repos/{o}/{r}/runs` — opened with `labels`, which ride **inside the
  signed run predicate**, so "this run was gemini" is attested rather than annotated
- `GET /api/adp/repos/{o}/{r}/runs/compare?intent_id=` — this *is* the exec summary
- named evals, latest-per-name, so two axes on one run do not overwrite each other
- `/verify`, whose `chains_ok` and `emitters_ok` stay two answers rather than one

It requires **two ADP identities** — a runner and a grader — asserted at boot via
`GET /api/v3/user`, because `separately_authorized` compares identity, not token.

### adp-replay → duva-bench — the statistics library

**Both** duva-bench tracks compute their statistics with `adp_replay.stats.paired`, on
purpose: the two tracks differ in how a trial is executed and in nothing else, so if they
also differed in how a difference is tested, a divergence between them would be
uninterpretable.

- squad track bridge: `squad/packages/duva-bench/tools/paired_stats.py`, invoked from
  `src/stats-bridge.ts`

> **Fixed 2026-08-08, verified 2026-08-10.** This bridge used to reach into a *working
> copy* (`sys.path.insert(0, ~/dev/adp-replay/src)`, an interpreter at
> `~/dev/adp-replay/.venv/bin/python`) — no CI could run it, no one else could reproduce
> a published number. It is now installed as a real dependency, pinned by commit in
> `packages/duva-bench/requirements-stats.txt`, built into its own venv by
> `scripts/setup-stats.sh` (uv-managed Python where the system interpreter can't build a
> venv). `study.statsVersion` records the resolved commit. **Trap to watch for
> instead:** that venv is machine-local and gitignored, so a stale or half-built one
> (missing `pyvenv.cfg`) silently reads as "just run `setup-stats.sh` again," not as a
> report-generation failure worth investigating further — confirmed by a real instance
> of exactly that on 2026-08-10, `--force` rebuild fixed it.

### duva-bench squad track ↔ Harbor track

Two **deliberately parallel** tracks. The pair is itself an experiment on bespoke vs.
in-distribution infrastructure, so they must stay comparable:

- shared task contract: a `goal.md` + seed repo + `grader.mjs` triple
- run labels `platform: squad` / `platform: harbor`
- the shared statistics library above, so a divergence cannot be a difference in method

> **Status (updated 2026-08-10).** The Harbor track's pause was **lifted 2026-08-08** — an
> end-to-end probe ran there, clearing the dependency-configuration blocker. The squad
> track has run a live pilot (`a-tool-familiarity-pilot`) and, separately, M3-5's arm 3
> (squad PR #119). No shared cells exist yet — that needs the Harbor track reaching its
> own M8 with a shared task set — so the cross-track gate (squad's SG3b) is still
> deferred, not paused and not failed.

---

## 3. What breaks what

| A change here | Requires this, there |
|---|---|
| ADP minor version bump (additive) | adp-replay: bump `ADP_REF`, then `make sync-spec && make generate`, and commit the regenerated client. **Nothing does this automatically.** |
| ADP breaking change | Everything above, plus squad-lab's `AdpClient` and duva-bench's `analysis.ts`, both of which re-read runs from ADP rather than local state. |
| New field on a native-plane response | Nothing downstream sees it until adp-replay regenerates — and it will not be typed at all until responses carry schemas (issue #64). |
| Changing what `runs/compare` returns | squad-lab's exec summary and duva-bench's `analysis.ts` both read it directly. |
| `adp_replay.stats.paired` semantics | **Both** duva-bench tracks, silently — there is no pin today. |
| Renaming a run label | duva-bench resumption reads ADP, not local state; labels are immutable once set at open. |
| `make down` on the local ADP stack | Minted identities do not survive it. squad-lab and duva-bench both fail with a 401 on `GET /api/v3/user` until re-minted. |

---

## 4. Plans of record

| Project | Plan |
|---|---|
| adp | [`/ROADMAP.md`](../ROADMAP.md) — status ledger; [`docs/pragmatic_mvp.md`](pragmatic_mvp.md) — scope, cut list, per-milestone narrative |
| adp | [`docs/trajectory-eval-slice.md`](trajectory-eval-slice.md) — runs, trajectories, eval-gated close |
| adp-replay | `adp-replay/docs/execution-plan.md` |
| squad-lab | the milestone reports `m0`–`m14`, in **duva-lab-tpm** (private) |
| duva-bench, squad track | `squad/packages/duva-bench/PLAN.md` (S0–S7) |
| duva-bench, Harbor track | `duva-bench/docs/execution-plan.md` (M0–M8) |

Cross-project findings, and the open backlog they generated, live in **duva-lab-tpm**'s
`portfolio-audit-2026-08-08.md`. The contract defects that document reports against this
repo are filed as issues [#63](https://github.com/DeDuva/adp/issues/63) (closed) and
[#65](https://github.com/DeDuva/adp/issues/65) (closed — became `docs/api-compatibility.md`'s
"Plane dependencies" section). [#64](https://github.com/DeDuva/adp/issues/64) — native-plane
response schemas — is still open; see `ROADMAP.md`'s Blockers.
