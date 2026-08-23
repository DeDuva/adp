# ADP — Plan

**This file is the repo's only executable backlog, and the authority on scope.** Every open
work item lives here, in one of the phases below, with its real state and the evidence for
that state. If a piece of work is not in this file, it is not planned — that is the point of
the file.

| Document | Answers | Does not |
|---|---|---|
| **`PLAN.md`** (this file) | What is *left*, in what order, and why | Record what already shipped |
| [`CHANGELOG.md`](CHANGELOG.md) | What shipped, under which version | Track open work |
| [`README.md`](README.md) | What ADP is and how to try it | Either of the above |

**The rule that keeps this file honest:** every item names its tracking issue or PR, and
`scripts/check-docs.sh` fails the build when a `#NNN` here disagrees with its real state on
GitHub. This file cannot rot without breaking `make check`.

Completed phases are not kept here. Work that shipped is described in `CHANGELOG.md` under
the version that carried it; a backlog that also records its own history stops being a
backlog and becomes a ledger nobody trusts.

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
| 3-6 | Retention and tiering as org policy | blocked on 3-5 | The intended shape — hot/extended tiers with promote-on-reference, attestations committing to digests never payloads, "verified, payload not retained" as an honest third verification state — is settled; the numbers that justify it come from 3-5. The object-store half also waits on decision 2 |

---

## Phase 4 — Answer the three open decisions

Three decisions are open. Each is answerable, and each has an experiment.

| # | Decision | Experiment | State |
|---|---|---|---|
| 4-1 | **OD-1** — what is the native plane for, and what does it cost? | Close the MCP tool gap (no proposal-open tool today, so the agent pays a `curl` round-trip `gh` bundles into one command), then re-run arm 2 at study scale and add the long-trajectory and novel-CLI-from-docs arms | not started. Arm 2 measured ADP-MCP at $0.1435/trial against $0.0848 via `gh` and $0.0850 on real GitHub — a first-party number that contradicts our own bet |
| 4-2 | **OD-2** — can a gate detect an agent that has satisfied its own tests? | A held-out-vs-visible pass-rate bench arm, same shape as arms 2 and 3. 2-1 is its first half | not started. The flakiness half shipped (Wilson-lower-bound `gates_confident`, quarantine as an operation); none of the reward-hacking half did |
| 4-3 | **OD-3** — will a harness vendor adopt, and what is the minimum portable slice? | Register ADP as a reverse-DNS MCP extension; take 2-3's demo to two harness teams | not started. MCP 2026-07-28 removed protocol sessions and told servers to mint explicit handles — the technical path is now a namespace registration. Most of the open positions wait on the design partner this produces |

---

## Deferred, with the reason

| Item | Why it is not in a phase |
|---|---|
| **Hosted preview** — M4-8 (managed Postgres + object store), M4-10 (backup/PITR + executed drill) | Blocked on decision 2 (budget) and decision 3 (drill timing). Engineering is not the constraint. Split out of M4 so a purchase order stops holding a milestone open |
| **M4-6 — SSO/SCIM** | Deferred by decision, not blocked. Parked until a procurement conversation demands it: significant work against a real IdP, with no current consumer |
| **M5 — substrate hardening** | Evidence-gated by design: jj-derived change engine, VFS lazy materialization, speculative merge batching, pluggable storage backends, per-path ACLs, structural merge. Each needs a written justification citing telemetry. None has one. The speculative-batching gate stays closed — now because merge-queue batching adoption sits at 6%, not because conflicts are rare, which the co-activity data denies |
| **#64 — native-plane response schemas** | Frozen debt by design. The recording hot path is typed; the rest sit behind the `server/src/spec-coverage.test.ts` opt-out list, which may only shrink |
| **Dependency admission beyond npm** | A known work item with a known fix. Admission is real for npm lockfiles and nothing else, so an instance running any other ecosystem gets no dependency gate |

---

## Cross-repo

| Item | State |
|---|---|
| adp-replay: bump `ADP_REF` past the 0.3.0 batch and fix the tautological drift check | unknown — tracked in neither repo, and never picked up |
