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

## Phase 1 — Adoption: the bindings

**Why now:** a first-contact evaluation (2026-08-24, umbrella #140) walked the product as a new
developer would, and did not reach the payoff. The finding is not that a capability is absent.
Every blocker it names is a missing *default* on a capability that already works: the change
record binds intent to diff, and the push path writes `intent_id` null; the trajectory store is
complete to the last column, and nothing writes to it; provenance carries harness and model, and
no route sets either. **The substrate is built and the bindings are missing** — which is why this
phase sits ahead of the rest of the file rather than beside it, and why most of it is small.

The rule the evaluation proposes, kept here because it decides what belongs in this phase: every
input ADP requires is either *irreducible* (only a human can supply it — what you want, and
whether you accept the result), *derivable* (ADP can compute it from what it holds), or
*delegable* (a machine other than the human emits it). An input in the second or third category
that a human is supplying is a defect. Each item below moves exactly one.

### 1a — Bound: a change carries its own context

No new services and no new concepts. Exit criterion: a commit pushed by a plain `git push`, from
any harness, resolves to its intent, and the evidence bundle names that intent by title.

| # | Item | Tracking | State |
|---|---|---|---|
| 1-1 | Token mint carries `harness`, `model` and `session_id` | #141 | not started. The columns, the reader and the signer all exist; `server/src/http-rest/tokens.ts` accepts none of the three, so the fields are unreachable over HTTP |
| 1-2 | Commit trailers bind a pushed change to its intent | #142 | not started. `server/src/core/change-recorder.ts` hardcodes `intentId: null`, so no commit recorded by a push is bound to anything. Highest ratio of unblocked value to lines changed in this phase |
| 1-3 | One change row per sha, and a deterministic evidence read | #143 | not started. The explicit create neither dedups nor is constrained unique, so the documented workaround for 1-2 writes a second row and the evidence read picks between them unordered |
| 1-4 | Native-plane tools to open, review and merge a proposal | #144 | not started. The first step of OD-1's experiment, tracked here because this is where the work is |
| 1-5 | Refusals name the command that satisfies them | #145 | not started. The refusal is what a first-time user came to see; it names the unmet requirement and stops one step short |
| 1-6 | Local TLS as a supported mode rather than a test fixture | #158 | not started. `gh` refuses plain HTTP for any other host, and `server/acceptance/run.sh` already solves this for tests alone |

2-1 belongs to this release as well: a developer evaluating ADP alone is both author and
approver, so the refusal 1-5 teaches them to satisfy is, on their own instance, satisfiable by
the person it exists to constrain.

### 1b — Ambient: capture without being asked

Exit criterion: a developer connects a harness, works an ordinary session, and finds the whole
trajectory in ADP having called no ADP API — at an agent cost indistinguishable from a session
with ADP absent.

| # | Item | Tracking | State |
|---|---|---|---|
| 1-7 | `adp-recorder` — a buffered, replay-safe event producer, out of band | #149 | not started. Blocked on 3-1, 3-2 and 1-8, in that order. A sibling to `runner/` on the same terms: a pure HTTP client, no server import, no signing key |
| 1-8 | Secret detection at the trajectory ingest path | #148 | not started. Push protection scans the diff; a trajectory holds everything the agent *read*, including files no diff ever touched |
| 1-9 | Harness readers, two to start, and named in the README | #150 | not started. Translation lives in the recorder, so the server keeps storing `harness` as a string it never branches on |
| 1-10 | Session lifecycle driven by harness signals | #151 | not started. What turns 2-3 into a demonstration rather than a script that calls two endpoints |
| 1-11 | `adp connect <harness>` | #154 | not started. Proves itself with a round trip rather than reporting success on having written files |

**Recording is out of band, and that is the thesis rather than an optimisation of it.** Arm 2's
MCP arm recorded no trajectory at all and still cost $0.1435/trial against $0.0848 for the same
work via `gh`. That gap is protocol round-trips, and per-event recording is the one workload that
would multiply it — in exactly the measurement a prospect uses to compare us.

### 1c — Legible: the record has a reader

Exit criterion: someone who has never read the API documentation answers "why does this line
exist" from the browser in under a minute.

| # | Item | Tracking | State |
|---|---|---|---|
| 1-12 | `adp init` — attach to a repo that already exists, and detect the toolchain | #153 | not started. Mirror mode is the way in: it asks one developer to add a remote rather than a team to agree |
| 1-13 | CLI: `watch`, `undo`, `bakeoff`, `runner` | #155 | not started. Removes the last two raw round-trips from the canonical walkthrough |
| 1-14 | Runs, sessions, trajectories and evals in the UI | #156 | not started. `server/web/src/App.tsx` has six views and none of them is any of these, so the whole M3 surface is API-only |
| 1-15 | Commit → intent → run navigation | #157 | not started. Depends on 1-2: today `intent_id` is null for the ordinary case, so the path resolves to nothing |
| 1-16 | An interim retention default | #161 | not started. 3-6 is the real policy and waits on 3-5; this decides only what happens in the interval, which 1-7 makes expensive to get wrong |

3-4, 2-2 and 2-3 belong to this release as well.

### 1d — Legible before install: the published site

The three releases above begin at `git clone`. The site is what a developer reads while deciding
whether to type it, so it precedes every other item in this phase — and it is the one surface
where a change publishes itself, since `.github/workflows/pages.yml` deploys `docs/html/` on every
push to `main` that touches it.

It is admitted here on that ground rather than the one above: it moves no input between the three
categories. #138 gave the site a front door, and named what it was leaving open.

Exit criterion: the published site renders from 320 px to 1440 px with no horizontal scroll on the
body and no table that needs pinch-zoom, every margin comes from one named scale, and nothing it
serves depends on a package this repository does not contain.

| # | Item | Tracking | State |
|---|---|---|---|
| 1-17 | One design system for the site, and no runtime it cannot rebuild | #163 | not started. `docs/html/support.js` is generated from a `dc-runtime/` that is not in this tree, so `/why/` cannot be fixed or upgraded by anyone working here; #138 confined that dependency to the secondary page rather than resolving it. The two pages also share no styles — the palette is declared twice, the container widths disagree at `940px` against `1120/760/520`, and the landing page's verticals are seven unrelated margins with an inline `style=` at the one place the scale ran out |

---

## Phase 2 — The serial-base-case forward work

**Why now:** the 2026-08-17 reweighting named three consequences and none of them was ever
tracked. They are the differentiator the reweighting implies, and 2-1 doubles as the first half
of open decision OD-2. All three now have a release in Phase 1 to land in.

| # | Item | Tracking | State |
|---|---|---|---|
| 2-1 | Author-independent approval — `one_approval` currently accepts the author approving their own proposal | #121 | not started. `server/src/core/land-policy.ts:140`. Observed live in the arm-2 bench trajectories. Also a precondition of a bake-off meaning anything, where every author is an agent |
| 2-2 | Compensating-revert undo — undo that survives a moved branch, rather than only CAS rollback | #159 | not started. Lands with 1c |
| 2-3 | Cross-harness checkpoint/resume demo | #160 | not started. Also the instrument for OD-3, which is why it earns its place twice. Waits on 1-10, without which it is a bespoke script rather than evidence of portability |

---

## Phase 3 — Storage durability

**Why now:** the storage analysis (2026-08-22) modelled growth from 1,930 real trajectory
events and found the first failures are cheap to fix and the expensive ones are not yet urgent.
So the cheap fixes land first, then the measurement, then the architecture — in that order,
because this project does not build on a model when it can build on a number.

**What changed on 2026-08-24:** 3-1 and 3-2 stopped being cheap fixes taken early and became
*prerequisites*. Their urgency was correctly judged low while nothing wrote to these tables at
volume; 1-7 is the thing that writes to them, and it is the first real load this schema has seen.
Shipping capture before the ceiling and the indexes exist hands the most enthusiastic user a way
to fill their own disk, and they will report it as ADP being unreliable rather than as ADP being
popular. 3-4 moves for the same reason, one release later.

| # | Item | Tracking | State | Why |
|---|---|---|---|---|
| 3-1 | Index `operations` for the queries actually run against it | #147 | not started. Prerequisite of 1-7 | One index (`repo_id`) exists while the history endpoint and the org audit export both filter and sort on `created_at`, `actor_id`, `verb` and `org_id`. The export's `OR(repoId …, orgId …)` cannot use it at all and buffers in memory |
| 3-2 | Bound trajectory payloads | #146 | not started. Prerequisite of 1-7 | `payload` and `state` are both `z.unknown()`. Measured mean is 833 B/event, but nothing in the code prevents the 85 KB/turn the industry anchor suggests — a 20× range with no ceiling |
| 3-3 | Make the SBOM deterministic so identical dependency sets dedup | — | not started | `randomUUID()` and a fresh timestamp per land make ~8 KB of every ~12 KB landed change un-dedupable and ~100% redundant. Pure win; needs no object store |
| 3-4 | Stream or bound `verifyChain` | #152 | not started. Lands with 1c | It loads an entire session into memory, and `/runs/:id/verify` does `Promise.all` over every session at once, behind a plain `repo:read` token. Checkpoints already sign the chain head, so incremental verification is available and unused |
| 3-5 | Bench arm 4 — `storage-growth` | — | not started | Deterministic, no model, no tokens, CI-runnable like arm 1: bytes per unit on a real Postgres, realised vs batched compression, dedup yield, ingest cliff, peak RSS on `/verify` |
| 3-6 | Retention and tiering as org policy | — | blocked on 3-5 | The intended shape — hot/extended tiers with promote-on-reference, attestations committing to digests never payloads, "verified, payload not retained" as an honest third verification state — is settled; the numbers that justify it come from 3-5. 1-16 covers the interval. The object-store half also waits on decision 2 |

---

## Phase 4 — Answer the three open decisions

Three decisions are open. Each is answerable, and each has an experiment.

| # | Decision | Experiment | State |
|---|---|---|---|
| 4-1 | **OD-1** — what is the native plane for, and what does it cost? | Close the MCP tool gap — 1-4, so the agent stops paying a round-trip `gh` bundles into one command — then re-run arm 2 at study scale and add the long-trajectory and novel-CLI-from-docs arms | not started. Arm 2 measured ADP-MCP at $0.1435/trial against $0.0848 via `gh` and $0.0850 on real GitHub — a first-party number that contradicts our own bet |
| 4-2 | **OD-2** — can a gate detect an agent that has satisfied its own tests? | A held-out-vs-visible pass-rate bench arm, same shape as arms 2 and 3. 2-1 is its first half | not started. The flakiness half shipped (Wilson-lower-bound `gates_confident`, quarantine as an operation); none of the reward-hacking half did |
| 4-3 | **OD-3** — will a harness vendor adopt, and what is the minimum portable slice? | Register ADP as a reverse-DNS MCP extension; take 2-3's demo to two harness teams | not started. MCP 2026-07-28 removed protocol sessions and told servers to mint explicit handles — the technical path is now a namespace registration. Most of the open positions wait on the design partner this produces |

---

## Settled, and what would reopen it

Phase 4 names what is still open. This names what is closed, so it does not get relitigated
without new evidence — and, for the positions this project holds rather than merely decided,
what would actually change them.

Every row here was settled by building or measuring rather than by argument, which is the
strongest claim this project makes about its own method.

| Question | Resolution | Settled by |
|---|---|---|
| Depth of GitHub compatibility | A pragmatic partial shim is sufficient; real unmodified `gh` drives the full loop | Shipping it, and pinning it in CI |
| Bespoke store vs. git objects | Real git objects plus Postgres | Building it |
| Jujutsu: adopt, fork, or reimplement | Neither — the ADP verb set over plain git | Cut early; never missed |
| Structural (AST) merge vs. agent-mediated | Neither is needed: the gate means merge mistakes must be *caught*, not prevented | Cut; the gate does the work |
| Is agent memory a merge problem? | No. It needs the same audit trail and provenance, not the same write path | Narrowed by implementation |
| The monorepo assumption | Not load-bearing at this scope; mirror mode makes ADP additive first | Mirror mode shipping |
| Wide fan-out vs. long serial sessions | **Small-N concurrent with one integrator is the base case.** Fan-out cost 3.6× for no measurable quality gain | Our own pre-registered arm (`bench/README.md` arm 3), plus market evidence |
| Does merge contention bottleneck fleets? | Not at the ref level. But contention is real and lands elsewhere — 79.4% of agent PRs are temporally co-active, and the largest single cause of death is *another PR fixing the same thing* | External measurement ([arXiv:2607.04697](https://arxiv.org/abs/2607.04697), 33,596 PRs), correcting our earlier reasoning |
| Erosion of the PR shape | Survivable by construction: evidence and history hang off changes and operations, never off `proposal` | Schema discipline, audited |
| Queue implementation | The bespoke `gate_jobs` queue stays; `pg-boss` is not restored | #92–#96, and the reasoning in `AGENTS.md` |

### Positions, and the tripwire for each

A position with no stated tripwire is a belief, not an engineering decision. Each row names what
would change it, and whether that has happened.

| Position | What would change it | Tripped? |
|---|---|---|
| **Centralized source of truth** with offline-tolerant edges. CRDTs guarantee convergence, not correctness, and code demands correctness | An air-gap or data-residency requirement from a real partner | No |
| **Signed provenance on every change**, aligned with WIMSE/Agentic-JWT rather than invented | A consumer refusing to persist traces for IP, safety or discoverability reasons — the schema would need graduated disclosure, which the opaque-payload seam already anticipates | No consumer yet |
| **Implementation-first standardisation**, spec published early, conformance suite as the hedge | The incumbent shipping attested, non-bypassable evidence binding — not merely more gates | No |
| **Adapters, never scanners.** One bundled engine (secret detection at the receive path) and no first-party SAST/SCA | Procurement demanding batteries-included baseline scanning | **Partly** — on breadth, not on principle: dependency admission and SBOM emission are npm-only. Carried in *Deferred* below |
| **Two-level policy resolution inside the substrate**, org floor ∧ repo file, both signed and versioned | An enterprise insisting its existing policy engine stays the source of truth — ADP would become an enforcement point binding external decisions into the signed land record | No |
| **Compliance as a byproduct**, not a product: the evidentiary substrate is guaranteed, and GRC tooling renders reports from it | Auditors rejecting attestation envelopes and demanding certified report formats | No |

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
