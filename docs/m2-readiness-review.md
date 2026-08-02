# M2 Readiness Review

*2026-08-01 · Written between M1 completion and M2 kickoff. Companion to
[`pragmatic_mvp.md`](pragmatic_mvp.md) (the plan of record, amended by this review) and
[`agent-native-vcs-brief-v5.md`](agent-native-vcs-brief-v5.md) (appendix items A16–A18 added by
this review).*

M1 is complete and green in CI. Before starting M2, this review answers three questions: how the
original assumptions are holding up — in particular, what ways agents may evolve the product
development lifecycle *other than* the wide-fan-out-bottlenecking-on-merge hypothesis; whether the
architecture as actually built is performant and scalable (would it serve a Chromium-class repo,
and would a team migrating from GitHub see regressions); and what those two answers change in the
upcoming milestones.

The summary: the assumption ledger is holding up well and the appendix discipline is doing its job,
but three PDLC-evolution scenarios are missing from it, and the central merge-bottleneck hypothesis
still has zero measurement behind it anywhere in this repo. The architecture is deliberately not a
scale system and that was the right call — but **M2's mirror mode moves scale exposure from M5 to
M2**, because mirroring imports real GitHub repos with real histories, and a handful of "M5 scale
items" are actually M2 correctness bugs. The milestone changes that follow are scoped accordingly:
a scale-hygiene block and merge-method fidelity added to M2, two benchmark arms added to M3, and
M4/M5 left untouched — the evidence-gating discipline on M5 is working as designed.

---

## 1. How the assumptions are holding up

The brief's appendix (A1–A15) was built to be falsified, and through July 2026 it is tracking
reality honestly:

- **A10 (incumbent response) is materializing on schedule.** Agent HQ, the agent-apps Marketplace,
  Microsoft's first-party harness. The v5 update already shifted probability mass toward the
  conformance-layer fallback; `spec/` + `conformance/` being real and CI-enforced since M0 is the
  hedge working as intended. No further action beyond the standing-intelligence function A10
  already prescribes.
- **A12 (harness adoption) gained evidence in both columns**, exactly as the v5 update recorded —
  MCP's distribution for, accelerating harness-side governance drift against. The §f trust plane
  remains the strongest adoption lever; M2's trust ramp is correctly sequenced.
- **The trust plane demand thesis (§f) is aging well** — the CRA clock (September 11, 2026) is now
  weeks away, which strengthens the M2 SBOM/dependency-admission scope rather than changing it.

### Three scenarios missing from the ledger

The thesis image — an orchestrator fans out 200 attempts, garbage-collects 195, and the fleet
bottlenecks on verification and merge — is likely, but it is one point in a space. Three adjacent
evolutions deserve ledger entries (added to the brief as A16–A18) because each would reweight the
roadmap if it dominated:

**A16 — Wide fan-out vs. long serial sessions.** Test-time-compute economics may favor one strong
agent iterating serially — checkpoint, evaluate, continue — over hundreds of parallel attempts.
Current harness evolution (long-horizon sessions, context compaction, persistent memory) points at
least partly this way. In that world, candidate sets matter less and checkpoint/resume, op-log
continuity, and session-state versioning matter more. The roadmap is partially hedged already: M3's
cross-harness checkpoint/resume is exactly the serial-world primitive. The gap was that the hedge
was implicit; A16 makes it explicit, and the M3 benchmark now measures both patterns rather than
assuming fan-out.

**A17 — Contention avoided upstream.** Orchestrators may partition work — by ownership, file
sets, or build-graph blast radius — so that ref-level merge contention rarely occurs in practice,
the way capable engineering orgs already shard work across teams. If conflict rates in real fleet
runs are low, the bottleneck lands on eval compute and review latency rather than the merge path:
that weakens the speculative-merge-batching bet (Layer 3's queue) and strengthens the statistical
gating bet (A8), which binds regardless of where contention lives. Nothing in the MVP is
invalidated either way — serial FF land is compatible with both worlds — but M5's "speculative
merge batching" gate should demand conflict-rate telemetry, not just throughput telemetry, and M3's
benchmark now measures real conflict rates to feed this.

**A18 — Erosion of the PR shape.** Proposals are GitHub-shaped because the compat plane demands it.
But agents may converge on continuous micro-landing — stacked changes, land-as-stream, trunk-based
with the merge queue as the only integration point — and on regeneration-over-maintenance, where
the durable artifact is the *intent* and the diff is a disposable projection. Both erode the PR as
the unit of review. The domain model is reasonably positioned (intent is already first-class and
proposals reference it, not vice versa), and the discipline to keep is schema-level: the native
plane must never make `proposal` load-bearing for evidence, provenance, or history — those hang off
changes and operations, which survive any change-shape.

### The measurement gap

The merge-bottleneck hypothesis — the thesis — has no measurement behind it in this repo. No
contention test, no load test, no conflict-rate data; ForgeMark is a line in the landscape table.
This is acceptable pre-M2 (there is no fleet to measure), but M3 was already the benchmark
milestone and its scope only measured token cost and command count. The M3 amendment adds a
merge-contention arm and a fan-out-vs-serial arm so that by M3 exit the central hypothesis has
first-party evidence — and so the M5 gates have telemetry to cite, as they require.

A related small gap: M2 says GraphQL coverage is "widened from measured real traffic," but nothing
measures traffic today. Instrumentation is a prerequisite of that line item, not an optimization —
it is now named in M2 scope. It also feeds A2's research directly (which endpoints agents actually
hit) at near-zero cost.

---

## 2. Is the architecture performant and scalable?

Honest verdict: the implementation is a deliberately scoped MVP — one box, one volume, subprocess
to real `git`, no caches, no queues — and the cut list says so on purpose. Nothing here is an
accidental design flaw. But "would it serve Chromium" and "would a GitHub migrator see regressions"
have concrete answers worth stating plainly, because M2's mirror mode changes who encounters them.

### What holds up

- **Clone/fetch/push delegate wholesale to `git http-backend`**, streamed in both directions
  without buffering (`server/src/http-git/proxy.ts`). Wire performance is native git's, which is
  the right baseline; shallow and partial clone work for free.
- **The merge path is correct under concurrency.** FF-only land guarded by an atomic
  compare-and-swap on the ref (`GitBackend.fastForwardRef`, `server/src/core/git-backend.ts`) —
  N concurrent merges serialize, N−1 get a typed 409 and rebase. Correct, if not fast; and per A17,
  "not fast" may never matter at MVP fleet sizes.
- **Token auth is keyed** (`tokens.lookupKey`, indexed) — the one scale item flagged in the
  2026-07-26 review was fixed in M1b′.

### Live bugs at M2 (not M5) — fixed in M2 scope

Mirror mode means real GitHub repos with real histories arrive at M2. Against that workload:

1. **The post-receive hook silently records at most 500 commits per ref update**
   (`server/src/http-git/hooks.ts:126`). A mirrored or imported history larger than that loses
   signed-change records with no error — a silent hole in exactly the provenance record the product
   exists to keep. Fix: chunk or queue, never truncate silently.
2. **There are no secondary indexes at all** — `server/drizzle/*.sql` contains only primary keys
   and unique constraints. The `changes (repoId, gitSha)` dedup lookup runs **once per pushed
   commit** inside post-receive (`hooks.ts:136-139`); `gate_results` lookups scan per land-policy
   evaluation; the op-log query filters an unbounded append-only table by `LIKE` on a text `target`
   with no `repoId` column. All three are sequential scans that a history import turns into a
   quadratic push path. Fix: an index pass (and either a `repoId` column on `operations` or an
   expression index that serves the `target` filter).
3. **Unbounded list endpoints.** `GET /pulls` returns every proposal
   (`server/src/http-rest/proposals.ts:159`) and `GET /git/refs` returns every ref
   (`server/src/http-rest/git-data.ts:166-175`) — no limit, no cursor. A mirrored repo with
   thousands of PRs or refs makes these a memory and latency problem. Fix: pagination consistent
   with GitHub's (`per_page`/`page`), which is also a compat-fidelity gain.
4. **Merge-method fidelity.** The merge endpoint never reads its request body: GitHub's
   `merge_method` (`merge` | `squash` | `rebase`) is silently ignored and every land is a
   fast-forward (`proposals.ts:277-362`, `http-gql/resolvers.ts` `mergePullRequest`). A migrator's
   `gh pr merge --merge` "succeeds" while doing something semantically different from GitHub — the
   worst kind of gap, invisible until history is inspected. **Decision taken in this review:
   implement real merge-commit and squash support in M2.** Rebase-merge can remain unimplemented
   with a typed error (it is the least-used method and FF is its near-neighbor), but silently
   ignoring the parameter ends at M2.
5. **Land-policy TOCTOU.** Policy is evaluated before the ref CAS, not atomically with it
   (`proposals.ts:305` vs `:330`) — a gate result or approval can change in the gap. The ref CAS
   keeps the *git* side sound; the policy verdict is what can go stale. Small window, but the
   product's one-line pitch is "the merge is gated on evidence," so the gate should be re-checked
   after the CAS point or the accepted window documented in the spec. M2 decides which; the review
   flags it.

### The scale envelope, stated

Until M5 evidence says otherwise, the supported envelope is roughly: repos that materialize in
seconds not minutes (working sets in the low GB), ref counts in the thousands not millions, pushes
whose commit count fits one chunked recording pass, and fleet concurrency in the tens. Inside that
envelope, performance is native-git-plus-one-Postgres-roundtrip and there is no reason a migrator
sees regressions once the M2 items above land. Outside it — Chromium-class repos (tens of GB,
~10⁶ commits, thousands of concurrent writers) — the answer is **no, by design**: that world needs
the M5 items (VFS lazy materialization, speculative batching, storage backends, caching layers),
and each stays behind its written-justification gate. The honest migration-parity position, per
§1.2C of the plan of record: greenfield agent workloads and mirror-mode adoption are the target and
achieve parity-or-better; wholesale estate migration of a giant monorepo is out of scope and the
review declines to imply otherwise.

One further note for M3 planning: the op-log path filter shells `git diff-tree` per candidate
operation (`server/src/http-rest/operations.ts`) — O(matched history) with a subprocess per row.
Fine at MVP scale, and `adp_history_query` is the native plane's flagship read; if M3's fleet
benchmark shows agents leaning on it as hard as the thesis predicts (§1.2F: the read path is where
agents burn tokens), a path index moves from M5-shaped to M3-shaped. Flagged, not scheduled.

---

## 3. Milestone adjustments

Applied to `pragmatic_mvp.md` Part 3 by this review:

**M2 — additions.**
- *Scale hygiene forced by mirror mode* (findings 1–3 above): chunked post-receive recording with
  no silent truncation; the secondary-index pass; pagination on unbounded list endpoints.
- *Merge-method fidelity* (finding 4): real merge-commit and squash; typed error for
  rebase-merge.
- *TOCTOU decision* (finding 5): re-check policy at the CAS point, or document the accepted window
  in `spec/`.
- *API-traffic telemetry* as a named prerequisite of "GraphQL coverage widened from measured real
  traffic" — also feeds A2.
- *At kickoff:* resolve the two open questions in [`environments-plan.md`](environments-plan.md)
  §5 (SIGNING_KEY custody including the retired-key trust model; dev-instance ownership and
  retirement condition) — the dev environment is forced by M2's inbound webhooks, so these block
  the milestone's first week, not its last.
- *Exit criteria extended:* a mirrored repo with a >500-commit history has a signed change recorded
  for every commit; `gh pr merge --merge` and `--squash` produce GitHub-equivalent history.

**M3 — additions.** The benchmark harness gains two arms beyond token/tool-call/error-rate/wall-clock:
- *Merge-contention arm:* land throughput and retry behavior under N concurrent agents targeting
  one branch — the first first-party measurement of the merge-bottleneck thesis, ForgeMark-comparable,
  including conflict-rate telemetry (feeds A17 and the M5 speculative-batching gate).
- *Fan-out-vs-serial arm:* cost and outcome comparison of K parallel candidate-set attempts vs one
  serial checkpoint-resume session on the same tasks (feeds A16).

**M4 / M5 — unchanged.** The evidence-gating discipline on M5 is reaffirmed, not relaxed: the M2
pull-forwards above are justified precisely because mirror mode makes them correctness issues at
M2, not because scale work has become fashionable. Everything still speculative — VFS, batching,
storage backends, structural merge — still requires written justification citing M3/M4 telemetry,
which the M3 benchmark arms now exist to produce.
