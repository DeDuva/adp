# M3 Readiness Review

*2026-08-03 · Written between M2 completion and M3 kickoff. Companion to
[`pragmatic_mvp.md`](pragmatic_mvp.md) (the plan of record, amended by this review),
[`m2-readiness-review.md`](m2-readiness-review.md) (its predecessor), and
[`adp-prototype-implementation-plan.md`](adp-prototype-implementation-plan.md) (the source of the
D1/D2 demos M3 exits on).*

This review answers three questions before M3 starts: did M2 actually deliver what its **Exit:**
paragraph promised; was anything in M2 built suboptimally; and is M3 specified well enough that it
can be executed without re-deriving the design at every step.

The summary: **M2 is substantially delivered but one exit criterion is not genuinely met** — a
mirrored repo's *first* import records one commit, not its history, and the test that covers the
criterion is written to step around that exact case. Two smaller M2 defects are worth fixing on
the way into M3. M3 itself is sound in direction but is five sentences of scope carrying a
milestone's worth of work: it names no schema, no endpoints, no file layout, and its exit criterion
inherits a demo (D1) whose text calls for a capability the plan explicitly defers to M5. §4 below
replaces those five sentences with an ordered, self-contained work plan.

---

## 1. Did M2 meet its exit criteria?

The predecessor review's own lesson was to audit against the milestone's **Exit:** paragraph
rather than against the list of things that got built. Applying that here, line by line:

| # | Exit criterion | Verdict |
|---|---|---|
| 1 | An existing GitHub repo gets ADP workspaces + evidence without migrating | **Met.** Mirror mode is real and was proven against live github.com on the dev box |
| 2 | A `wizcli` gate posts findings as signed evidence on a proposal | **Met.** `adapters/wizcli/`, parsers tested against captured real-scanner output |
| 3 | A lockfile diff adding a known-malicious package is refused with a typed verdict | **Met.** `core/dependency-admission.ts`, verified against the live OSV API |
| 4 | A **mirrored** repo with a >500-commit history has a signed change recorded for **every** commit | **Not met.** See below |
| 5 | `gh pr merge --merge` and `--squash` produce GitHub-equivalent history | **Met.** `core/merge.ts`, shared by REST and GraphQL, exercised by the conformance run |
| 6 | `gh run list` relays upstream for a mirrored repo, non-mirrored repos keep the self-describing 404, exactly one evidence row per completed run | **Met.** `http-rest/actions.ts` + the partial unique index on `gate_results (repo_id, external_id)` |

### 1.1 Criterion 4 is not met, and the test hides it

`core/change-recorder.ts`'s `recordPushedCommits` branches on whether the ref already existed:

```ts
if (oldSha === ZERO_SHA) {
  const commits = await gitBackend.log(owner, name, newSha, 1);   // the tip. only the tip.
  await recordCommitsBatch(...);
  return;
}
```

For an ordinary new local branch that shortcut is right — the branch forks from history that is
already recorded, so re-walking it would be waste. For a **first mirror import** it is wrong, and
the file says so in its own comment: the branch is brand-new on the ADP side but carries real,
never-before-seen history. `http-rest/mirror-webhook.ts:187` passes `currentSha ?? ZERO_SHA`, so
the first inbound webhook for a branch ADP has never seen takes exactly this path. A 40,000-commit
repo mirrors in and the evidence plane records **one** signed change.

That is the single failure mode the product is not allowed to have — a silent hole in the
provenance record — and it is the same class of bug the M2 readiness review pulled forward from M5
in the first place (finding 1, the 500-commit truncation). The truncation half was fixed; the
new-ref half was left, tracked in a comment, and never closed.

What makes this worth calling out rather than filing quietly: **the test written for criterion 4
avoids the failing case on purpose.** `server/test/e2e-hooks.test.ts` pushes a root commit first,
then 511 more, and its comment explains why — "a brand-new branch (push #1) takes a separate
'record the tip only' path … pushing this root commit first … is what exercises the chunking loop
instead." The chunking loop is genuinely covered. The criterion, which says *mirrored*, is not:
there is no test in `e2e-mirror.test.ts` that imports a branch ADP has never seen. A green suite
therefore reports an exit criterion as met that the code does not satisfy.

The lesson to carry forward is narrower and sharper than the last one. Auditing against **Exit:**
was necessary but not sufficient, because the exit criterion *had* a passing test next to it. The
additional check is: **does the test exercise the scenario in the criterion's own words, or a
neighbouring one that was easier to set up?** Criterion 4 says "a mirrored repo". The test pushes
over HTTP to a local repo. That substitution is where the gap lived.

Fix and regression test are work item **M3-0** in §4.

### 1.2 Two smaller M2 defects

**Webhook CRUD writes nothing to the operation log.** `http-rest/webhooks.ts` never calls
`recordOperation`, while every other M2 write path does — mirrors, gates, dependency admission,
SBOM. M4 promises "audit-log export (a projection of `operations`, not a second system)"; a
projection is only as good as its completeness, and registering an outbound webhook — pointing a
signed feed of repository activity at an arbitrary URL — is precisely the kind of act an audit log
exists to record. Cheap to fix, and cheaper now than after M4 has built a compliance story on top
of the table.

**The Actions passthrough ignores the mirror's `enabled` flag.** `http-rest/actions.ts` looks a
mirror up and relays if one exists at all. A mirror that has been deliberately disabled — the same
flag `mirror-webhook.ts` honours by refusing to ingest — still decrypts the operator's PAT and
proxies upstream. Low severity, but "disabled" should mean disabled on every path that reads the
credential, and the divergence between the two files is the kind that gets noticed the hard way.

Direction, by contrast, should *not* be checked here, though the first draft of this review
suggested it. The webhook route only ingests `workflow_run` for `inbound`/`both`, so for an
outbound-only mirror the passthrough is the only way that repo's upstream CI is visible at all —
restricting by direction would delete the capability rather than tighten it.

### 1.3 What M2 got right, and should be kept doing

Worth recording because it is repeatable, not as praise. Parsers were tested against output
captured from the real tool rather than fixtures written to match the parser's own assumptions —
which is what caught osv-scanner emitting `level: "warning"` for genuine vulnerabilities. Purl
construction was checked against purl-spec's worked example. The OSV malicious-package integration
was confirmed against a live query for a real `MAL-` advisory. Exactly-once evidence ingest was
enforced by a database constraint rather than by application code remembering to check. Each of
these is a case of verifying against the authority instead of against one's own model of it, and
each caught something. M3's benchmark work is the place this discipline matters most, because a
benchmark that measures the wrong thing convincingly is worse than no benchmark.

### 1.4 One process note

The M2 pattern of parallel PRs drifting on shared surface (`schema.ts`, `config.ts`, the `repoId`
requirement introduced mid-milestone) was caught by CI after merge each time and same-day fixed.
M3 has more genuinely independent workstreams than M2 did — sessions, statistical gating, and the
benchmark harness touch almost nothing in common — so the ordering in §4 puts the one shared-surface
change (the schema additions) first and lets the rest fan out behind it.

---

## 2. Is M3, as written, executable?

M3's current text is:

> 50-way fan-out orchestration over candidate sets. Cross-harness checkpoint/resume (session state
> as a first-class ADP object — the §e demo). Statistical land criteria v0: flaky-gate quarantine,
> confidence-interval gating — the A8 contribution. Benchmark harness published (tokens / tool calls
> / error rate / wall clock: GitHub+`gh` vs ADP-MCP vs ADP-via-`gh`) … **Merge-contention arm** …
> **Fan-out-vs-serial arm** …
> **Exit:** D1 and D2 from the prototype doc are demonstrable; benchmark published with methodology.

The direction is right and nothing in it should be dropped. But six things are underspecified or
contradictory enough to derail execution, and they are fixed by the amendments in §3.

**a. D1's text calls for a capability the plan defers to M5.** D1 reads "watch the merge queue
*speculatively batch* candidates". Speculative merge batching is an explicit M5 item, gated behind
written justification citing M3/M4 telemetry — telemetry the M3 merge-contention arm exists to
produce. Taken literally, M3's exit criterion requires the thing M3 is supposed to generate the
evidence for. Resolution: **M3 satisfies D1 with serial land, not speculative batching**, which is
the MVP land model (§2.5) and is sufficient for every observable in D1's own description — fan out
50, gate them, land the winner with evidence, GC the rest. This has to be written down, or it gets
resolved differently by whoever executes it next.

**b. D1 requires GC that nothing implements.** "…land the winner with its evidence bundle, **GC the
rest**." `workspaces` has `expiresAt` and `destroyedAt` columns and `core/workspaces.ts` can destroy
one on request, but nothing sweeps. General quota-driven GC is M4 ("quotas and GC") and should stay
there; what M3 needs is narrower and belongs with the feature that creates the garbage —
**candidate-set-scoped reclamation**: when a set is resolved, the losing candidates' workspaces are
destroyed and their proposals closed, as recorded operations.

**c. "50-way fan-out orchestration" does not say what is being built.** The candidate-set data model
already exists (`core/candidate-sets.ts`, two MCP tools, `proposals.candidateSetId`). What does not
exist is anything that makes a set *resolve*: `selectionPolicy` is a free-text column defaulting to
`"manual"` that no code reads, selection does not land the winner, and losers are left running. The
work is finishing the lifecycle, not building fan-out from scratch — and saying so prevents a
from-scratch rebuild of what M1c already landed.

**d. The candidate-set comparison view is still missing and D1 depends on it.** M1's own text closes
with "The one remaining gap is UI-only: the web UI has no candidate-set comparison view." D1's
stated payoff is the history view — "one landed change, intent attached, 49 discarded attempts
queryable but not polluting history." That is a UI deliverable and it is currently nobody's.

**e. Session state is named but not specified.** "Session state as a first-class ADP object" implies
a schema, a set of verbs, REST and MCP surfaces, spec files, and a signing story — none named. Two
constraints have to be stated up front because retrofitting them is impossible. First, per **A18**,
`proposal` must never become load-bearing for evidence, provenance, or history — so sessions hang
off `operations` and `changes`, never off proposals. Second, D2's claim is "one continuous
**signed** history across both harnesses", so a checkpoint is signed evidence, not a scratch blob,
and resume records a lineage link rather than starting a fresh story.

**f. The benchmark has no credential, cost, or reproducibility story.** Three of the arms need a
real agent burning real tokens, and one needs a real GitHub repo and PAT. Nothing in CI can run
those, and "benchmark published with methodology" is a credibility play (prototype doc §8.3) that
fails badly if the numbers are not reproducible by a reader. This needs an explicit split — which
arms are deterministic and CI-enforced, which are agent-backed and run by hand — and it needs the
split written into the published methodology rather than discovered by whoever tries to reproduce
it.

---

## 3. Milestone adjustments

Applied to `pragmatic_mvp.md` Part 3 by this review:

**M3 — clarifications (no scope added).**
- *D1 is satisfied by serial land.* Speculative merge batching stays M5 and stays evidence-gated;
  M3's merge-contention arm is what produces the evidence it is gated on. Nothing in D1's
  observable list requires batching.
- *Candidate-set lifecycle completion* is what "50-way fan-out orchestration" means: real selection
  policies, land-on-select, and candidate-set-scoped reclamation of losing workspaces. The data
  model itself already landed in M1c.
- *The candidate-set comparison view* (outstanding from M1) is M3 scope, because D1 exits on it.
- *Sessions and checkpoints* are specified in §4 (M3-2): schema, verbs, REST, MCP, `spec/`, and the
  signing/lineage rules that make D2's "one continuous signed history" true rather than asserted.
- *Statistical land criteria* are specified in §4 (M3-3), including the estimator, the config
  surface, and the rule that a quarantined gate is always visible and never silently green.
- *Benchmark split:* the merge-contention arm is deterministic, needs no model, and is CI-enforced.
  The three-way cost comparison and the fan-out-vs-serial arm are agent-backed, run out of band,
  and publish captured run records so a reader can re-derive the numbers without re-running them.

**M3 — additions (two, both small and both forced by findings above).**
- *M2 debt paid first:* the initial-mirror-import provenance hole (§1.1), plus the two minor defects
  in §1.2. M3's benchmarks run against mirrored real repos, so this is a prerequisite of the
  milestone's own measurements, not merely leftover M2 tidying.
- *Exit criteria extended:* a repo mirrored in from GitHub with a >500-commit history has a signed
  change per commit **on first import**; a session checkpointed under one harness identifier and
  resumed under another yields one signed, linked history across both; a gate that fails
  intermittently is quarantined visibly rather than blocking or silently passing.

**M4 / M5 — unchanged.** In particular the M5 speculative-batching gate is reaffirmed: point (a)
above resolves an ambiguity in D1's wording in favour of the gate, not around it.

---

## 4. The M3 work plan

Ordered. Each item states what to change, where, and what has to be true before it is done. Items
M3-1 through M3-5 depend on M3-1's schema landing first; after that they are independent.

Conventions for every item: work on a branch off `main`, land via PR, never commit to `main`
directly. `make test-all` must be green before opening the PR. New tables need a Drizzle migration
in `server/drizzle/`. New native-plane objects need a JSON schema in `spec/schemas/` and an entry in
`spec/openapi.yaml`. Every state change goes through `recordOperation` — that is the append-only
spine invariant, and it is not optional for new verbs.

### M3-0 — Pay the M2 debt

**0a. First-import provenance (§1.1).** In `server/src/core/change-recorder.ts`, replace the
`oldSha === ZERO_SHA` tip-only shortcut with a paged walk of the full history reachable from
`newSha`, stopping at the first page that records nothing new.

The stop condition is what keeps this cheap: `recordCommitsBatch` already dedups against
`changes (repo_id, git_sha)` (indexed since M2), so an ordinary branch forked from recorded history
walks one or two pages and stops, while a first mirror import walks everything. Do not reach for
`git log --not --exclude=… --all` to compute "new history" — `--all` includes `HEAD`, which in a
bare repo resolves to the default branch and silently empties the result for exactly the
first-import case this fixes.

`recordCommitsBatch` must return the number of rows it inserted so the loop can see "nothing new".

Tests: in `server/test/e2e-mirror.test.ts`, a mirror whose **first** inbound webhook delivers a
branch ADP has never seen, with >500 commits, records a signed change for every one of them. This
is criterion 4 in its own words, and it must fail against the current code before it passes.

**0b.** `http-rest/webhooks.ts`: `recordOperation` on create and delete, verbs `webhook.create` /
`webhook.delete`, inside the same transaction as the write. Never record the secret.

**0c.** `http-rest/actions.ts`: treat a disabled mirror, and a mirror with no inbound relationship
to upstream, the same way a non-mirrored repo is treated — the self-describing 404. One test per
case.

### M3-1 — Schema for sessions, checkpoints, and candidate-set resolution

One migration, landed before the rest so the parallel items do not collide on `schema.ts` the way
M2's did (§1.4).

`sessions` — a unit of agent work that outlives any one harness:
`id`, `repo_id` → repos, `intent_id` → intents (nullable), `harness` (text; the harness identifier
that opened it, e.g. `claude-code`), `actor_id` → identities, `workspace_id` → workspaces
(nullable), `status` (`active` | `suspended` | `resumed` | `closed`), `resumed_from_session_id`
(nullable self-reference — the lineage link D2 turns into "one continuous history"), `created_at`,
`updated_at`. Index on `(repo_id, status)`.

`checkpoints` — signed, ordered points a session can be resumed from:
`id`, `session_id` → sessions, `seq` (integer, monotonic per session), `git_sha` (the workspace tip
at checkpoint time), `harness` (which harness wrote it), `state` (`jsonb` — harness-supplied opaque
resume state), `envelope` (`jsonb`, notNull — the DSSE envelope, same shape and same role as
`gate_results.envelope`), `created_at`. Unique on `(session_id, seq)`.

Two rules on `state` that have to hold from the first commit. It is opaque to ADP — never parsed,
never branched on; a harness that stores its own format must not require an ADP change to do so.
And it is covered by the signature: the DSSE statement binds `git_sha` **and** a hash of `state`,
so a resume in a different harness can verify it received what was written.

`candidate_sets` gains `status` (`open` | `resolved` | `abandoned`, default `open`) and
`resolved_at`. `selection_policy` stops being free text — see M3-2.

### M3-2 — Candidate-set lifecycle: fan-out that resolves (D1)

`server/src/core/candidate-sets.ts`.

**Selection policies.** Constrain `selectionPolicy` to `manual` | `first_green` | `best_score`, and
make each mean something. `manual`: today's behaviour, an explicit select call. `first_green`: the
first candidate whose land policy evaluates clean wins. `best_score`: candidates carry a numeric
score reported as an ordinary gate result (`name: "score"`, the value in the DSSE statement) and the
highest wins; ties break by earliest proposal number, so the outcome is deterministic and
reproducible in a benchmark.

**Land on select.** Selecting a candidate lands it through the existing `core/merge.ts` path — the
same land policy, the same evidence, the same signed change. No second merge implementation and no
bypass of the gate: a selected candidate that fails land policy returns the policy's `unmet` list
and the set stays open. Serial land, not speculative batching (§2a).

**Reclamation.** Resolving a set destroys the losing candidates' workspaces (`core/workspaces.ts`,
which already deletes the ref and stamps `destroyedAt`) and closes their proposals, each as a
recorded operation. Losers stay *queryable* — that is D1's whole point, "49 discarded attempts
queryable but not polluting history" — so rows are never deleted, only their refs reclaimed.

Surfaces: `POST /api/adp/candidate-sets/:id/resolve`, and MCP `adp_candidates_resolve` alongside the
existing open/select tools. Verbs: `candidateset.resolve`, `candidateset.reclaim`.

Tests: 50 candidates opened concurrently against one intent resolve to exactly one landed change,
49 closed proposals, 49 destroyed workspaces, and one operation per reclamation. Concurrency is the
point of the test, not decoration — 50 concurrent ref writes into one bare repo is the first time
this code sees that.

### M3-3 — Sessions and checkpoints (D2)

`server/src/core/sessions.ts`, `server/src/http-rest/sessions.ts`, MCP tools, `spec/schemas/session.json`
and `spec/schemas/checkpoint.json`.

Verbs: `session.start`, `session.checkpoint`, `session.resume`, `session.close` — all through
`recordOperation`, with `parentOp` linking a resume to the checkpoint it resumed from so the op log
alone reconstructs the lineage.

REST: `POST /api/adp/repos/:owner/:repo/sessions`, `POST /api/adp/sessions/:id/checkpoints`,
`GET /api/adp/sessions/:id/checkpoints`, `POST /api/adp/sessions/:id/resume`,
`GET /api/adp/sessions/:id`. MCP: `adp_session_start`, `adp_checkpoint_create`, `adp_session_resume`,
`adp_session_list`.

Resume semantics, stated precisely because this is the demo: resuming checkpoint *c* of session *s*
under harness *h′* creates a **new** session row with `resumed_from_session_id = s`, `harness = h′`,
and a workspace forked at `c.git_sha`; marks *s* `resumed`; and records `session.resume` with
`parentOp` pointing at *c*'s `session.checkpoint` operation. The old session is never mutated beyond
its status — history is append-only.

Verification on resume is not optional: the checkpoint's DSSE envelope is verified before the new
workspace is created, and a failed verification is a typed 422 naming the checkpoint. An unverified
resume would make "one continuous signed history" false while looking true.

Tests: an e2e that starts a session as `harness: "claude-code"`, checkpoints, resumes as
`harness: "openhands"`, commits again, lands through the normal proposal path, and then asserts that
a single op-log query returns the whole chain across both harness identifiers with intact `parentOp`
links. That query *is* D2 — if it takes more than one call, the object model is wrong.

Note on honesty in the demo: this proves the *protocol* is harness-neutral, which is the claim.
Vendoring two real harnesses is not M3 scope and the published demo should not imply it did.

### M3-4 — Statistical land criteria v0 (A8)

`server/src/core/flake-stats.ts` and changes to `core/land-policy.ts` + `core/repo-policy.ts`.

Derive, do not denormalize: flake statistics are computed from `gate_results`, which already keeps
every rerun rather than overwriting. A second table would be a dual-write and the plan forbids those
on principle. Add whatever index the trailing-window query needs and measure it.

*Measured (2026-08-03).* The existing `(repo_id, git_sha, name)` index does not serve this query —
it asks for the trailing N results for one *gate across commits*, so the planner could only bitmap-
scan on `(repo_id, name)` and then sort every result that gate had ever produced. At 20,000 results
for one gate: **11.7 ms** with a top-N heapsort, versus **0.078 ms** as an ordered index scan once
`(repo_id, name, created_at)` exists — and the unindexed cost grows with history while the indexed
one does not. Land policy is evaluated twice per merge plus once per candidate during a 50-way
fan-out, so this is squarely the "sequential scan a history import turns quadratic" class the M2
readiness review pulled forward. Migration `0013`.

**Flake rate.** For gate `g` in repo `r`: over the trailing `min_runs` results, a *flip* is a
`git_sha` for which `g` reported both `success` and `failure`. Flake rate is flips ÷ distinct shas
observed.

**Quarantine.** If flake rate exceeds `quarantine_threshold`, `g` is quarantined: its failures stop
blocking land and are reported as `pending` with a summary naming the quarantine. Quarantine is
**always visible** — surfaced in the land-policy `unmet`/advisory output and recorded as a
`gate.quarantine` operation the first time it takes effect for a given commit. A gate that silently
stops mattering is worse than a flaky gate, and this is the specific failure this item must not
have.

**Confidence gating.** A new land requirement `gates_confident`, alongside `gates_green`. For gate
`g` with `k` successes in `n` trailing runs, compute the **Wilson score interval** lower bound at
the configured confidence and require it to meet `min_pass_rate`. Wilson, not the normal
approximation — at the small `n` this will actually see (a handful of runs), the normal
approximation is wrong in the direction that matters, and it is wrong by enough to pass a gate that
should not pass. Below `min_runs`, `gates_confident` falls back to `gates_green` and says so in its
output rather than failing closed on thin data.

Config in `adp.yaml`, extending the existing `RepoPolicySchema`:

```yaml
land:
  require: [gates_green, gates_confident]
  statistical:
    min_runs: 5
    confidence: 0.95
    min_pass_rate: 0.9
    quarantine_threshold: 0.2
```

Unit tests on the estimator against hand-computed Wilson bounds — this is the A8 contribution and a
wrong interval discredits the claim more than not making it. Plus an e2e: a gate made to fail
intermittently is quarantined, the quarantine appears in the land-policy output, and the operation
is recorded.

### M3-5 — Benchmark harness (D4)

New top-level package `bench/`, matching the `adp-bench` repo in the prototype doc's appendix.
Layout: `bench/tasks/` (task suite), `bench/arms/` (one driver per arm), `bench/runs/` (captured run
records, committed), `bench/report/` (the published methodology and results), `bench/README.md`.

**Arm 1 — merge contention. Deterministic, no model, CI-enforced.** N concurrent writers open a
proposal against one branch and land it, retrying on the typed 409. Measures land throughput, retry
distribution, conflict rate, and p50/p95 land latency. This is the first first-party measurement of
the merge-bottleneck thesis and it needs no LLM, so it runs in CI at small N and by hand at large N.
Conflict rate is a required output, not optional: A17 and the M5 speculative-batching gate both
consume it.

**Arm 2 — three-way cost comparison. Agent-backed, out of band.** Identical task suite completed via
(a) GitHub + `gh`, (b) ADP-MCP, (c) ADP via `gh`. Measures tokens, tool calls, error rate, wall
clock. Requires a real agent and, for (a), a real GitHub repo and PAT.

**Arm 3 — fan-out vs serial. Agent-backed, out of band.** K parallel candidate attempts against one
serial checkpoint-resume session on the same tasks, comparing cost and outcome. Feeds A16, and
depends on M3-2 and M3-3.

**The reproducibility contract**, which is the part that makes this a credibility play rather than a
press release. Every run writes a machine-readable record to `bench/runs/` — task suite version,
model identifier, server commit, raw per-task measurements, environment. The report derives every
published number from those records, and a script regenerates the report from them, so a reader can
check the arithmetic without re-running an agent. Arms that were not run are reported as not run.
State plainly which numbers are deterministic and which came from a stochastic agent, and give the
spread rather than a single figure for the latter.

Publish whichever way it points. Per A1 this benchmark gates our own investment, and per the
prototype doc's §8 the value is in running it transparently — a benchmark that only gets published
when favourable is not evidence.

### M3-6 — Candidate-set comparison view

`server/web/` — the D1 money shot: one candidate set, its intent, every candidate with its gate
results and score, which one landed, and the 49 that did not, all queryable. Read-only, consistent
with the rest of the supervision UI. Covered by the acceptance run's UI tier.

---

## 4a. Status (updated 2026-08-10 — M3 complete)

M3-0 through M3-6 have all landed; see the M3 section of the plan of record for the per-item detail.
All three M3-5 benchmark arms are published: arm 1 (merge contention — deterministic, CI-enforced),
arm 2 (three-way cost comparison — pilot scale, 12 trials,
[`bench/report/three-way-cost.md`](../bench/report/three-way-cost.md)), and arm 3 (fan-out vs
serial — run in squad's duva-bench track, [squad PR #119](https://github.com/DeDuva/squad/pull/119)).
Arms 2 and 3 needed a real agent and (for arm 2) a real GitHub PAT and so ran out of band from CI,
per the contract this section originally set: publish whichever way the numbers point, and report an
unrun arm as not run rather than omit it. Neither arm was omitted or approximated.

One finding worth recording from running arm 1, because it was not predicted: total attempts track
**N(N+1)/2 exactly** at every N measured. Writer *k* retries *k* times, so work grows quadratically
while lands grow linearly. That is the merge-bottleneck thesis showing up as a clean closed form in
first-party data for the first time. It is not on its own an argument for M5's speculative batching —
A17 has to fail first, i.e. real orchestrators have to actually contend — but it is exactly the
telemetry that gate was written to demand.

## 5. M3 exit criteria, restated

The original two, plus what §3 adds. All of these should be executable checks, not judgements:

1. **D1 demonstrable.** 50 candidates fan out against one intent, gates run, one lands with its
   evidence bundle by a stated selection policy, 49 are reclaimed and remain queryable, and the
   comparison view shows it. Serial land — speculative batching remains M5.
2. **D2 demonstrable.** A session checkpointed under one harness identifier and resumed under
   another produces one signed, lineage-linked history retrievable in a single op-log query, with
   checkpoint signatures verified at resume.
3. **Benchmark published with methodology**, including which arms are deterministic and which are
   agent-backed, with captured run records that let a reader re-derive every published number.
4. **Statistical gating is real and visible.** A gate that fails intermittently is quarantined, the
   quarantine is recorded and surfaced, and `gates_confident` gates land on a Wilson lower bound.
5. **The M2 debt is paid.** A repo mirrored in from GitHub with a >500-commit history has a signed
   change recorded for every commit **on first import**, proven by a test that mirrors — not one
   that pushes over HTTP and calls it equivalent.
