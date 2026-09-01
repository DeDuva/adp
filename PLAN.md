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
Every blocker it names is a missing *default* on a capability that already works: the trajectory
store is complete to the last column, and nothing writes to it; provenance carries harness and
model, and no route sets either. The first of them is closed — a pushed commit now binds to the
intent its trailer names, where before the push path wrote `intent_id` null unconditionally. **The substrate is built and the bindings are missing** — which is why this
phase sits ahead of the rest of the file rather than beside it, and why most of it is small.

The rule the evaluation proposes, kept here because it decides what belongs in this phase: every
input ADP requires is either *irreducible* (only a human can supply it — what you want, and
whether you accept the result), *derivable* (ADP can compute it from what it holds), or
*delegable* (a machine other than the human emits it). An input in the second or third category
that a human is supplying is a defect. Each item below moves exactly one.

### 1a — Bound: a change carries its own context

No new services and no new concepts. Exit criterion: a commit pushed by a plain `git push`, from
any harness, resolves to its intent, and the evidence bundle names that intent by title.

**Release 1a is complete**, and the criterion above is checked rather than asserted: the acceptance
walkthrough pushes a commit carrying an `ADP-Intent` trailer with plain `git push` and no ADP API
call, then reads the evidence bundle back and fails unless it names that intent *by title*. The
last item was the criterion itself — 1-18, #189 — which was nobody's issue until the six before it
closed and left it standing alone.

Its table is gone with it, because this file records what is left. For the record of which number
was which: 1-1 was the token mint carrying `harness`, `model` and `session_id`, #141, which makes
the provenance block on a signed change name the harness that produced it; 1-2 was commit trailers
binding a pushed change to its intent, #142; 1-3 was the second `changes` row the documented
push-then-bind sequence used to leave behind, #143, which the database now refuses; 1-4 was the
missing native-plane proposal tools, #144, for which an agent used to pay a raw `curl`; 1-5 was
the refusal that named the unmet requirement and stopped one step short of the command that
satisfies it, #145; 1-6 was local TLS, #158, which lived only inside the acceptance script and is
`make local` now; 1-18 was the evidence bundle naming the intent by id rather than by title, #189.
Their numbers are not reused — the issues filed against this phase cite these numbers, and a
recycled 1-2 would point two of them at different work.

1-5's suggested remedy for `one_approval` is `gh pr review --approve`, which became honest advice
only when 2-1 shipped: before it, a developer evaluating ADP alone was both author and approver, so
the refusal 1-5 exists to teach them to satisfy was, on their own instance, satisfiable by the
person it exists to constrain. That is why the remedy that shipped names *whose* approval, rather
than only the command.

### 1b — Ambient: capture without being asked

Exit criterion: a developer connects a harness, works an ordinary session, and finds the whole
trajectory in ADP having called no ADP API — at an agent cost indistinguishable from a session
with ADP absent. **Release 1b is complete**, and its table is gone with it, on the terms 1a and 1d
set: this file records what is left, and what shipped is in `CHANGELOG.md`.

Item 1-7 — `adp-recorder`, #149 — is finished and is gone from this table. It landed as
three changes, because a Size-L flagship is not reviewable at once: the delivery guarantees
(durable spool, batching shipper, idempotent replay, contiguity recovery, honest
backpressure), then the harness reader and the CLI, then the measurement. All four exit
criteria hold, and the fourth is worth restating here because it is the thesis:
**recording costs the agent nothing, and that is now a number.** 20 paired trials,
$0.0752/trial with the recorder off against $0.0730 with it on — paired mean difference
−$0.0022, 95% interval [−$0.0073, +$0.0029] — and 20/20 of the recorded trajectories
verified, so it is a measurement of the recorder rather than of its absence.

Item 1-9 — harness readers, two to start, #150 — is finished and is gone from this table on
the same terms. The recorder reads two harnesses now: Claude Code's `stream-json` and Codex's
`codex exec --json`, chosen for having a stable machine-readable event stream rather than for
being popular, and both named in the README along with what a harness *without* a reader still
gets — which is everything that rides on `git` and the commit trailer, and none of the
turn-level detail.

**The second reader was the one that made the interface real**, which is the argument for
having done it before 1-10 rather than after. One reader is an implementation detail of the
recorder; two put the contract in a file — `read`, `end`, `sessionFacts` — that a third-party
reader is loaded against with `--reader`, no patch to this package. And the two disagree in a
way one could not have shown: Claude Code assembles one `tool_call` from a pair of lines, Codex
collapses three lines carrying one item id, and both arrive as one event with a status because
that is what the fixed vocabulary is for. `harness` is still a string the server never branches
on. What did change is the boundary the readers cross: a reader emitting a `kind` outside the
vocabulary is a 422 at ingest and a 422 quarantines the session, so **one bad event from a
reader nobody here wrote would have cost the whole recording**. It is relabelled at the spool
now, and the record says a reader did it.

Item 1-10 — the session lifecycle, #151 — is finished and is gone from this table. All three of
its decisions had the wrong actor and now have none: a session opens bound to the intent HEAD's
trailer names, checkpoints at boundaries rather than intervals — a commit, a handoff, a quiet
stretch, the end — and ends `closed` or `suspended` according to whether the harness finished.
`suspended` was a status the schema had declared since sessions existed and **nothing had ever
set**, which was survivable while a human decided when a session was over and is not once a
recorder does.

**It also found the bug that made 2-3 impossible.** `checkpoints.state` is `jsonb`, which sorts
object keys and returns what it sorted, while the digest the checkpoint signs was taken over the
caller's key order — so a checkpoint whose state was not already in the column's order failed its
own digest check and was refused at *resume* time, permanently unresumable, discovered at the worst
possible moment. Nobody had hit it because hand-written checkpoint state is short; the recorder
writes five keys in the order a person would list them and it failed on the first attempt. The
digest is canonical now, in jsonb's own ordering — chosen because any other canonical order would
reintroduce the same bug in a new set of cases, and because it makes the fix free: every checkpoint
that verifies today has keys already in that order.

Item 1-11 — `adp connect <harness>`, #154 — is finished, and **release 1b is complete**. One
command per harness mints a token that names it, writes that harness's own configuration in its own
format at its own path, installs the `prepare-commit-msg` hook that was the client half #142 never
had, wires recording, and then opens and closes a real session to prove all of it — because a config
written to the wrong path fails silently and looks exactly like success.

Two things it found are worth carrying. **The round trip caught a design error on its first run**,
which is the argument for it: minting a token under a fresh per-harness principal produces a
credential with membership in no org and therefore access to nothing, and there is no REST route that
grants one. The token is minted under the caller's own principal instead — narrower than theirs
(never `admin`) and carrying the harness — which is also the more accurate claim, since a signed
change then names both the person and the harness. And **the config a harness reads has to hold the
token**, so connect writes a live credential into the working tree; the files go into
`.git/info/exclude` rather than `.gitignore`, per clone, because one developer's harness is not
every contributor's business.

1b's exit criterion — a developer connects a harness, works an ordinary session, and finds the whole
trajectory in ADP having called no ADP API, at an agent cost indistinguishable from a session with
ADP absent — is met for the two harnesses that have readers. Gemini CLI connects on the same command
and gets everything that rides on `git` and the commit trailer; what it does not get is turn-level
detail, which is the degraded mode #150 documented and not a gap this item left.

Item 1-19 — the trajectory payload default, #199 — is finished and is gone from this table, on
the terms 1a's items left: what shipped is in `CHANGELOG.md`, and the number is not reused. It
decided that a payload is stored as its *structure* by default and in full only where a repo asks,
which is the shape 1-7 is now built against. The asymmetry that settled it is worth carrying,
because every later retention question meets it again: a repo widens the setting after reading
what a trajectory holds, and nobody unsends what already arrived.

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
| 1-15 | Commit → intent → run navigation | #157 | not started. The commit-to-intent edge is populated now that trailers bind it; what is missing is a surface that follows it |
| 1-16 | An interim retention default | #161 | not started. 3-6 is the real policy and waits on 3-5; this decides only what happens in the interval, which 1-7 makes expensive to get wrong |

**1-14 is finished, and it found the limit of its own exit criterion.** The M3 surface has a reader
now — runs, run detail, the trajectory with its typed columns, verification as two separate answers,
and session lineage across harnesses. What it cannot do is answer "what was this agent *saying* when
it wrote this line", because under #199's default `trajectory.payloads: structure` the strings are
replaced by their byte counts before the event is chained. The shape survives and the content does
not. Everything the run *did* is there — the tool, its verdict, the tokens, the cost, the commit —
and the view says which of the two it is showing rather than rendering the projection marker as
though the agent had said it.

That is the right default and it is worth restating here because it prices 1-16 and 3-6: the
structural projection is already a retention policy for the most valuable payloads, taken before
anyone measured what retaining them would cost. A repo widens it with one line of `adp.yaml`, and
`1-16`'s interim default should not quietly narrow it further on the same surface.

2-3 belongs to this release as well. So did 3-4 and 2-2, both finished: verification of a
trajectory now costs a constant rather than a session, which is the precondition for 1-14 putting a
verification badge on every run page; and undo has a second path, so it survives the branch moving —
which on an active repository it does within minutes of any merge. What remains of 2-2 is 1-13's
job, since the CLI is where a person actually reads which path an undo took.

### 1d — Legible before install: the published site

The three releases above begin at `git clone`. The site is what a developer reads while deciding
whether to type it, so it precedes every other item in this phase — and it is the one surface
where a change publishes itself, since `.github/workflows/pages.yml` deploys `docs/html/` on every
push to `main` that touches it.

It is admitted here on that ground rather than the one above: it moves no input between the three
categories. #138 gave the site a front door, and named what it was leaving open.

Exit criterion: the published site renders from 320 px to 1440 px with no horizontal scroll on the
body and no table that needs pinch-zoom, every margin comes from one named scale, and nothing it
serves depends on a package this repository does not contain — **all three met as of 2026-08-29**,
and asserted by `make site` rather than by inspection.

Item 1-17 — one design system for the site, and no runtime it cannot rebuild, #163 — is
finished and is gone from this table, in the same way 1-2 was: the runtime half landed in
#166 and the design-system half with this change. What shipped is described in
`CHANGELOG.md`; what it now holds itself to is `make site`, which drives both published
pages in a real browser and fails on any of the six exit criteria rather than leaving them
to inspection. **Release 1d is complete.**

1d's exit criteria are about whether the site *renders*; they say nothing about whether it
argues the right thing. A positioning review on 2026-08-29, against Anthropic's AI-native
SDLC playbook and the 2026 field data published alongside it, found the front page making a
narrower claim than the product: it answered the review stage only, stopped at the merge,
and carried cross-harness provenance — the one capability an incumbent cannot copy — in a
single table cell. The page now covers what the record is for after it lands, and why it has
to be portable across harnesses, and a third page at `/sdlc/` walks all six stages of the
loop those playbooks describe against what actually enforces each one. That is prose rather
than an input moved between the three categories above, so it opens no item here; it is
recorded because the next person to read this section should know the site was measured
twice, on two different criteria — and because `make site` now gates three pages, which is
the number a fourth has to join rather than quietly skip.

A third pass on 2026-08-30 measured the site for launch, finishing what the positioning
review began. The loop the playbooks describe is drawn now rather than only described — the
six stages, their committed artifacts, and the layer underneath, as one figure leading
`/sdlc/` with a compact variant opening the front page — and a second figure places ADP
among the tools around it, which is the picture that answers the rip-and-replace fear. The
three pages carry one masthead, so the reading order (front page, then the SDLC, then the
argument) is visible from any of them, and the license the pages advertise moved to MIT
with the tree it describes. Prose and drawings again, so it opens no item here; `make site`
still gates all three pages, with both new figures held to the same criteria as everything
else — no horizontal scroll at any width, structure from `docs/html/site.css` alone, and a
stacked reading below 700 px.

The hero followed the same day: the strip of anonymous dots became a stage the reader
operates — three buttons that refuse a change without evidence, undo a merge, and hand the
session to a different agent, each writing the ledger in front of them — scripted by a few
kilobytes of inline vanilla JavaScript so the page stays a file (#138), and rendering as a
finished tableau when scripts are off. The essay's copy of the old strip went with it: one
argument, one stage.

---

## Phase 2 — The serial-base-case forward work

**Why now:** the 2026-08-17 reweighting named three consequences and none of them was ever
tracked. They are the differentiator the reweighting implies. Both remaining items have a release
in Phase 1 to land in.

| # | Item | Tracking | State |
|---|---|---|---|
| 2-3 | Cross-harness checkpoint/resume demo | #160 | not started. Also the instrument for OD-3, which is why it earns its place twice. Waits on 1-10, without which it is a bespoke script rather than evidence of portability |
| 2-4 | Provenance-priced approval — the approver differs by model, harness or session, not merely by identity | #176 | not started, and unblocked: 1-1 (#141) shipped, so a token carries `harness`, `model` and `session_id` over the wire and a signed change names them |

Items 2-1 and 2-2 — author-independent approval, #121, and compensating-revert undo, #159 — shipped
and are gone from this table. Their numbers are not reused, for the reason given under 1a.

2-1 was the first half of OD-2 below, and the half that had to come first: until it landed,
`one_approval` was satisfiable by the principal it exists to constrain, so no bake-off's "landed"
column measured anything and no refusal 1-5 could honestly teach a solo evaluator to satisfy.

2-2 settled a question this file had left open, and the answer is worth keeping: **a compensating
revert goes through the land policy.** It is a change, and an undo that skipped the gate would be a
hole in the gate opened by the verb most likely to be used in a hurry. The consequence is that
`undo_path: revert` means "here is the change that undoes it" rather than "it is undone" — the
branch does not move until the revert proposal lands — and 1-13 has to say so at the point a person
reads it.

**2-4 is what it left undone**, and the gap is worth stating because the shipped check reads
stronger than it is. Comparing principals is a separation-of-*identity* control doing a
separation-of-*judgment* job, and it is wrong in both directions: it refuses an adversarial
reviewer agent that shares the author's token, and it accepts two tokens held by one person — or
two agents running the same model on the same context. Every forge is in the same position and
none of them can do better, because identity is all they record. ADP records what *produced* the
change, which is why 2-4 is a differentiator rather than a catch-up.

---

## Phase 3 — Storage durability

**Why now:** the storage analysis (2026-08-22) modelled growth from 1,930 real trajectory
events and found the first failures are cheap to fix and the expensive ones are not yet urgent.
So the cheap fixes land first, then the measurement, then the architecture — in that order,
because this project does not build on a model when it can build on a number.

Items 3-1 and 3-2 — indexing `operations` (#147) and bounding trajectory payloads (#146) — shipped
and are gone from this table, which clears **every prerequisite of 1-7**: `adp-recorder` (#149) is
unblocked, and 1b with it. 3-2 pinned the question the recorder will be built against: an oversized
event is **refused**, not dropped and not accepted with its payload replaced by a digest. The
digest option belongs to retention (3-6), where "verified, payload not retained" describes a
payload that *was* accepted and later aged out; using the same state for something never accepted
would make the one honest third verification state ambiguous exactly where it has to be precise. Its number is not reused, per the rule under 1a. Two findings are worth carrying. The
fix the issue proposed for the audit export (two indexed reads unioned) was measured and *does not
work*: Postgres will not turn `repo_id = ANY(…)` into an ordered scan, so a LATERAL that gives each
repo its own walk is what replaced it. And the faster answer — carrying `org_id` on every operation,
which makes the export a single indexed read — was tried and **reverted**, because that column
carries a foreign key and filling it everywhere puts a `FOR KEY SHARE` lock on one row per tenant
into the write path of every change. The 50-way fan-out test deadlocked on it. `make measure-ops`
reproduces all of it.

**What changed on 2026-08-24:** 3-1 and 3-2 stopped being cheap fixes taken early and became
*prerequisites*. Their urgency was correctly judged low while nothing wrote to these tables at
volume; 1-7 is the thing that writes to them, and it is the first real load this schema has seen.
Shipping capture before the ceiling and the indexes exist hands the most enthusiastic user a way
to fill their own disk, and they will report it as ADP being unreliable rather than as ADP being
popular. 3-4 moved for the same reason, one release later, and is gone from the table below on
the rule this file runs on — its number is not reused.

**3-4 also answered a question it was not asked**, which is worth keeping here because it changes
what a later item may assume. Recomputing a hash chain from its genesis does not detect an edit
made *consistently*: repair every hash behind the change and the chain verifies. What pins the
middle is a signature over a head the rewrite would have had to move, and the checkpoints have
held one all along with nothing reading it. Verification checks them now. So "the chain verifies"
was a weaker statement than this backlog assumed until 2026-08-31, and 3-6's third verification
state has one more thing to be precise about: a payload that was aged out is still covered by a
signed head, and that is what makes "verified, payload not retained" say something.

| # | Item | Tracking | State | Why |
|---|---|---|---|---|
| 3-3 | Make the SBOM deterministic so identical dependency sets dedup | #194 | not started | `randomUUID()` and a fresh timestamp per land make ~8 KB of every ~12 KB landed change un-dedupable and ~100% redundant. Pure win; needs no object store |
| 3-5 | Bench arm 4 — `storage-growth` | #195 | not started | Deterministic, no model, no tokens, CI-runnable like arm 1: bytes per unit on a real Postgres, realised vs batched compression, dedup yield, ingest cliff, peak RSS on `/verify` |
| 3-6 | Retention and tiering as org policy | — | blocked on 3-5 | The intended shape — hot/extended tiers with promote-on-reference, attestations committing to digests never payloads, "verified, payload not retained" as an honest third verification state — is settled; the numbers that justify it come from 3-5. 1-19 (#199) built the commitment half already: an event whose payload is stored as structure carries `payload_digest`, covered by the chain. 1-16 covers the interval. The object-store half also waits on decision 2 |

---

## Phase 4 — Answer the three open decisions

Three decisions are open. Each is answerable, and each has an experiment.

| # | Decision | Experiment | State |
|---|---|---|---|
| 4-1 | **OD-1** — what is the native plane for, and what does it cost? | Take arm 2 to study scale — more reps per cell, harder tasks — and add the long-trajectory and novel-CLI-from-docs arms | **the pilot question is answered; the bounded one is not.** The gap that motivated this is gone at pilot scale. Arm 2's baseline measured ADP-MCP at $0.1435/trial against $0.0848 via `gh`, with *every* MCP trial costing more than *every* `gh` trial — a clean separation, and a first-party number contradicting our own bet. The `post-144-tools` re-run (2026-08-30, 12 trials, $0.9491) puts ADP-MCP at $0.0892 against $0.0771: the ratio falls from 1.69× to 1.16×, and the per-trial ranges now overlap, so the two arms are no longer distinguishable at n=4. The leading hypothesis held — and `curl` stayed available and unadvertised throughout, used **zero times in twelve trials**, so the residual is what the native plane costs on its own tools rather than an agent still hand-assembling HTTP. What remains is structural: a candidate set is opened and resolved in two MCP round trips with no single `gh` command standing in for them. Bounding that needs study scale, which is what this row is now about |
| 4-2 | **OD-2** — can a gate detect an agent that has satisfied its own tests? | A held-out-vs-visible pass-rate bench arm, same shape as arms 2 and 3 | not started. Two of its three halves shipped: flakiness (Wilson-lower-bound `gates_confident`, quarantine as an operation) and self-approval (#121, author-independent `one_approval`). The reward-hacking half — an agent editing the tests that judge it — is the one still open, and the one the arm measures |
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
| **#175 — approval counts, and author-independence as a toggle** | Deferred by decision. `one_approval` is one boolean where GitHub has a 0–6 count and GitLab has an explicit "prevent approval by author" switch, so an instance cannot ask for two approvals or for an approval it does not care who gives. It is a **major** bump — the `require` enum is published in four places in `spec/openapi.yaml` — so it only makes sense inside another breaking batch, the way #97 carried the 0.3.0 moves. And no consumer asks: pre-PMF the audience evaluates alone, whose problem was #174, not the inability to require two |

---

## Cross-repo

| Item | State |
|---|---|
| adp-replay: bump `ADP_REF` past the 0.3.0 batch and fix the tautological drift check | unknown — tracked in neither repo, and never picked up |
