# ADP — Plan

**This file is the repo's only executable backlog.** Every open work item lives here, in
one of the phases below, with its real state and the evidence for that state. If a piece
of work is not in this file, it is not planned — that is the point of the file.

Three documents, three jobs, no overlap:

| Document | Answers | Does not |
|---|---|---|
| [`ROADMAP.md`](ROADMAP.md) | Where the project *is* — milestone status, contract version, blockers | Say how the next piece gets built |
| **`PLAN.md`** (this file) | What is *left*, in what order, and why | Argue the thesis or record history |
| [`docs/agent-native-vcs-brief.md`](docs/agent-native-vcs-brief.md) | Why any of it is worth building | Track work |

**The rule that keeps this file honest:** every item names its tracking issue or PR, and
`scripts/check-docs.sh` fails the build when a `#NNN` here disagrees with its real state on
GitHub. This file cannot rot the way its predecessors did without breaking `make check`.

Written 2026-08-22 as part of the v6 reset. It supersedes the scattered backlog that lived
across `docs/m4-readiness-review.md` §4, `docs/m4-postmortem-audit.md`, four GitHub issues,
three stale PRs, and ROADMAP's Now/Next prose — with no document holding all of it, which is
how three of its items came to be described wrongly in the status ledger.

---

## Phase 0 — Truth restoration

**Why first:** the 2026-08-22 audit found sixteen contradictions across the doc set, three of
them critical and all three in `ROADMAP.md` — the file that declares itself the only status
ledger. Nothing should be planned on top of a ledger that is false in three places, and no
new plan is worth writing if the same drift can happen to it.

| # | Item | State | Evidence |
|---|---|---|---|
| 0-1 | ROADMAP: 0.3.0 row said "not started"; it shipped and is tagged | done | commit `5eb471d`, tag `v0.3.0` |
| 0-2 | ROADMAP: M4-5 OIDC claimed "built and acceptance-tested against real Google" | done | there is no OIDC code in the tree; the claim had propagated to two other documents. The work itself is Phase 1 item 1-1 |
| 0-3 | ROADMAP: P2 items #98–#102 listed as still to come | done | all five closed 2026-08-14, PRs #116–#120 |
| 0-4 | ROADMAP + brief: the fan-out-vs-serial bench arm described as never run | done | it ran 2026-08-10, pre-registered, 20/20 verified, digest `cfebbb7d…` |
| 0-5 | `CLAUDE.md`: `gh pr checks` invariant asserted the opposite of what the test asserts | done | PR #53 closed the gap 2026-08-03; `acceptance/run.sh:251-266` |
| 0-6 | Two further copies of the same stale claim in `docs/test-environment-automation.md` | done | corrected in place, with the prediction it made left standing |
| 0-7 | P1-7: record the bespoke-queue decision the audit asked for | done | the only postmortem item never discharged; now a `CLAUDE.md` invariant |
| 0-8 | `docs/pragmatic_mvp.md` named `pg-boss`, which is in no package.json | done | consequence of 0-7 |
| 0-9 | `docs/html/index.html` — live on GitHub Pages — called shipped features "the current milestone work" | done | org policy plane, dependency admission, scanner adapters all shipped |
| 0-10 | Widen the freshness gate: `check-claude-md.sh` → `scripts/check-docs.sh` | done | paths + links across all tracked markdown, and issue/PR-state agreement in the status docs |
| 0-11 | Re-scope M4 so a budget decision stops blocking a milestone | done | hosted-preview slice split into its own ROADMAP row |

**Still open in Phase 0** — these need a human call, so they are listed rather than done:

| # | Item | State | Note |
|---|---|---|---|
| 0-12 | PR #82 (public-site status fix) | superseded — close it | Its ROADMAP half describes M4-9d as in flight; its `index.html` half is done by 0-9 |
| 0-13 | PR #85 (test-harness port races) | ready to merge, 10 days old | Merges cleanly. Needs a merge decision, not work |
| 0-14 | PR #86 (M4-12 self-host artifacts) | done | main merged in, both conflicts resolved: its ROADMAP hunk dropped (superseded), its Dockerfile fix superseded by #119's — which independently found the same bug — with M4-12's `npm ci` argument folded in |

---

## Phase 1 — Close the re-scoped M4

**Why now:** M4 was re-scoped on 2026-08-22 to exactly what can be finished without a spend
decision. Of six original exit criteria, one is met, one is substantially met but unratified,
one is partial, and two needed a provisioned instance — those two moved to the hosted-preview
row along with M4-8 and M4-10. What remains is engineering, and none of it is budget-gated.

| # | Item | Tracking | State |
|---|---|---|---|
| 1-1 | M4-5 — Google OIDC login | #103 | **done** — authorization-code flow with PKCE and a nonce, `external_identities` keyed on `(issuer, subject)`, auto-provisioning off by default, a login that cannot mint `admin`, and the whole flow tested against a real OpenID provider. Took the contract to 0.4.0, additively |
| 1-2 | M4-12 — self-host artifacts (helm + compose, from nothing) | PR #86 | **done** — a Helm chart that refuses to render on six under-specified inputs, a runner image, `docs/self-hosting.md`, and a `helm` CI job under `ADP_REQUIRE_HELM=1`. Verified by installing on a throwaway cluster and pushing a real commit through it. Satisfies exit criterion 6 |
| 1-3 | M4-3 — the storage quota that was never built | — | not started. `grep maxStorage server/src` finds nothing; it was deferred to M4-8, which is itself sized by this quota's shape. That circular dependency is broken by doing this half first |
| 1-4 | Exit criterion 4 — reconcile an audit export against the op log for the same filter | — | partial. Row counts are asserted; the criterion's own wording is not |
| 1-5 | Exit criterion 5 — ratify runner isolation as met | — | substantially met, unratified. Real-daemon negative proofs exist for cap-drop, pids-limit, `--network none` and timeout kill; no document records the criterion as satisfied |

**Re-scoped exit criteria for M4.** Criterion 6 (self-host from nothing, helm and compose) is met by
1-2. The rest are met when 1-3 … 1-5 land: org isolation is real (already
met, `server/test/e2e-org-isolation.test.ts`), the runner isolates as designed, an audit export
reconciles with the op log, and self-host works from nothing on both helm and compose.

---

## Phase 2 — The serial-base-case forward work

**Why now:** the 2026-08-17 reweighting named three consequences and none of them was ever
tracked. They are the differentiator the reweighting implies, and 2-1 doubles as the first half
of open decision OD-2.

| # | Item | Tracking | State |
|---|---|---|---|
| 2-1 | Author-independent approval — `one_approval` currently accepts the author approving their own proposal | #121 | not started. `server/src/core/land-policy.ts:140`. Observed live in the arm-2 bench trajectories |
| 2-2 | Compensating-revert undo — undo that survives a moved branch, rather than only CAS rollback | — | not started, no issue yet |
| 2-3 | Cross-harness checkpoint/resume demo | — | not started, no issue yet. Also the instrument for OD-3, which is why it earns its place twice |

---

## Phase 3 — Storage durability

**Why now:** the storage analysis (2026-08-22) modelled growth from 1,930 real trajectory
events and found the first failures are cheap to fix and the expensive ones are not yet urgent.
So the cheap fixes land first, then the measurement, then the architecture — in that order,
because this project does not build on a model when it can build on a number.

| # | Item | State | Why |
|---|---|---|---|
| 3-1 | Index `operations` for the queries actually run against it | not started | One index (`repo_id`) exists while the history endpoint and the org audit export both filter and sort on `created_at`, `actor_id`, `verb` and `org_id`. The export's `OR(repoId …, orgId …)` cannot use it at all and buffers in memory |
| 3-2 | Bound trajectory payloads | not started | `payload` and `state` are both `z.unknown()`. Measured mean is 833 B/event, but nothing in the code prevents the 85 KB/turn the industry anchor suggests — a 20× range with no ceiling |
| 3-3 | Make the SBOM deterministic so identical dependency sets dedup | not started | `randomUUID()` and a fresh timestamp per land make ~8 KB of every ~12 KB landed change un-dedupable and ~100% redundant. Pure win; needs no object store |
| 3-4 | Stream or bound `verifyChain` | not started | It loads an entire session into memory, and `/runs/:id/verify` does `Promise.all` over every session at once, behind a plain `repo:read` token. Checkpoints already sign the chain head, so incremental verification is available and unused |
| 3-5 | Bench arm 4 — `storage-growth` | not started | Deterministic, no model, no tokens, CI-runnable like arm 1: bytes per unit on a real Postgres, realised vs batched compression, dedup yield, ingest cliff, peak RSS on `/verify` |
| 3-6 | Retention and tiering as org policy | blocked on 3-5 | The position — hot/extended tiers with promote-on-reference, attestations committing to digests never payloads, "verified, payload not retained" as an honest third verification state — is stated in the brief. The numbers that justify it come from 3-5. The object-store half also waits on decision 2 |

---

## Phase 4 — Answer the three open decisions

The brief carries exactly three open decisions. Each is answerable, and each has an experiment.

| # | Decision | Experiment | State |
|---|---|---|---|
| 4-1 | **OD-1** — what is the native plane for, and what does it cost? | Close the MCP tool gap (no proposal-open tool today, so the agent pays a `curl` round-trip `gh` bundles into one command), then re-run arm 2 at study scale and add the long-trajectory and novel-CLI-from-docs arms | not started. Arm 2 measured ADP-MCP at $0.1435/trial against $0.0848 via `gh` and $0.0850 on real GitHub — a first-party number that contradicts our own bet |
| 4-2 | **OD-2** — can a gate detect an agent that has satisfied its own tests? | A held-out-vs-visible pass-rate bench arm, same shape as arms 2 and 3. 2-1 is its first half | not started. The flakiness half shipped (Wilson-lower-bound `gates_confident`, quarantine as an operation); none of the reward-hacking half did |
| 4-3 | **OD-3** — will a harness vendor adopt, and what is the minimum portable slice? | Register ADP as a reverse-DNS MCP extension; take 2-3's demo to two harness teams | not started. MCP 2026-07-28 removed protocol sessions and told servers to mint explicit handles — the technical path is now a namespace registration. Five of the six tripwired positions in the brief wait on the design partner this produces |

---

## Deferred, with the reason

| Item | Why it is not in a phase |
|---|---|
| **Hosted preview** — M4-8 (managed Postgres + object store), M4-10 (backup/PITR + executed drill) | Blocked on decision 2 (budget) and decision 3 (drill timing). Engineering is not the constraint. Split out of M4 so a purchase order stops holding a milestone open |
| **M4-6 — SSO/SCIM** | Deferred by decision, not blocked. Parked until a procurement conversation demands it: significant work against a real IdP, with no current consumer |
| **M5 — substrate hardening** | Evidence-gated by design: jj-derived change engine, VFS lazy materialization, speculative merge batching, pluggable storage backends, per-path ACLs, structural merge. Each needs a written justification citing telemetry. None has one. The speculative-batching gate stays closed — now because merge-queue batching adoption sits at 6%, not because conflicts are rare, which the co-activity data denies |
| **#64 — native-plane response schemas** | Frozen debt by design. The recording hot path is typed; the rest sit behind the `server/src/spec-coverage.test.ts` opt-out list, which may only shrink |
| **Dependency admission beyond npm** | The one partially-tripped tripwire in the brief. A known work item with a known fix, carried here rather than in the appendix — carrying work items is how an appendix gets back to eighteen entries |

---

## Cross-repo

| Item | State |
|---|---|
| adp-replay: bump `ADP_REF` past the 0.3.0 batch and fix the tautological drift check | unknown — tracked in neither repo. Named in the postmortem audit's closing paragraph and never picked up |
