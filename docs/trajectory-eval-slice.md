# Runs, trajectories, and eval-gated close

**Written:** 2026-08-04. Amends `docs/pragmatic_mvp.md` — this is a capability
slice, not a milestone; it does not move the M-ledger on its own.

## 1. The capability, stated once

> One Squad assignment creates an ADP run; each agent becomes an ADP session;
> every message, model call, tool execution, handoff, commit, and test result is
> durably appended; the run closes against a final Git SHA; a deterministic eval
> result is attached to that run and reported as gate evidence.

The end this serves is not audit. It is **eval-based optimization**: if what an
agent fleet did is recorded in a comparable shape, and what it achieved is scored
by an attested eval, then "which way of working is better" becomes a query rather
than an opinion. Everything below is chosen to make that query cheap and its
inputs hard to fake.

Brief v5 already names the gap this fills: capturing context is "the audit half;
**binding context to verification evidence at merge time is the half nobody has
built**". The run attestation (§4) is that binding.

## 2. What was already there, and what was missing

ADP had `sessions` and `checkpoints` from M3 (D2): one agent's work, checkpointed
against a git sha, DSSE-signed, resumable across harnesses. It had `gate_results`
as signed evidence, `candidate_sets` with a `best_score` selection policy, and an
append-only `operations` log.

Three things were missing.

1. **No level above a session.** An orchestrator's assignment spawns N agents. A
   session is one agent; nothing named the assignment, so nothing could be scored
   as a whole. You do not evaluate one agent's turn — you evaluate whether the
   assignment was completed.
2. **No trajectory.** A checkpoint recorded *where an agent got to*, never *what
   it did*. Messages, model calls, tool executions, and handoffs existed only
   inside whatever harness produced them.
3. **No binding from a score to the work that earned it.** A gate result named a
   commit. Nothing tied it to the trajectory, or to the eval definition that
   produced it — so "the same eval, rerun" was an assertion.

## 3. The three tables

`runs` — the assignment. `intent_id` is **required** (unlike `sessions.intentId`):
a run is the object an eval scores, and scoring work whose goal was never stated
gives you a number nobody can interpret later. `orchestrator` is opaque exactly
as `harness` is. `external_ref` carries a partial unique index, so an orchestrator
restarting after a crash **rejoins** its run instead of forking the trajectory
into two halves that each look complete.

`session_events` — the trajectory spine. `sessions.run_id` links the two.

`evals` — the run-scoped projection of an eval that was reported as a gate result.

### 3.1 Why a hash chain and not a signature per event

A run emits thousands of events. DSSE-signing each would price honest recording
out of the hot path, and *an orchestrator that cannot afford to record does not
record*. So each event commits to its predecessor (`prev_hash` → `hash`), and the
chain head — one value standing for the whole sequence — is what the **signed**
artifacts carry:

- a **checkpoint** now includes `trajectoryHead` and `eventCount` in its
  predicate, so a checkpoint attests to what the agent did, not only which commit
  it reached; a resume that verifies the checkpoint has transitively verified the
  trajectory behind it;
- a **run attestation** binds the final git sha to every session's chain head.

Tampering with any event, in any position, breaks every hash after it and fails
verification against a signature that was cheap because it was taken once.

The genesis hash is derived from the session id, so a sequence cannot be lifted
out of one session and replayed into another.

### 3.2 Why the typed columns

`payload` is opaque — ADP never parses it, the same rule `checkpoints.state`
follows. But eval-based optimization asks *"what did the runs that scored well do
differently?"*, which is aggregation over tokens, cost, latency, tool identity,
and outcome across millions of rows. Answering that by unpacking jsonb per row is
how this table becomes too slow to use. So `kind`, `type`, `status`, `model`,
`tokens_in`, `tokens_out`, `cost_micro_usd`, `duration_ms`, `git_sha`, and
`related_session_id` are typed columns.

They are a **projection, not a second source of truth** — and they are covered by
`hash` exactly as the payload is. That is not incidental: they are the numbers an
optimizer reads and a policy might act on, so a chain that vouched only for
`payload` would let them be rewritten while still verifying. `verifyChain`
recomputes every hash from the row's own contents, and the e2e test tampers with a
projection column specifically (`test/e2e-run-trajectory.test.ts`).

Two of those columns replace payload conventions with edges: `git_sha` on a
`commit` event joins the trajectory to the change record, and
`related_session_id` on a `handoff` event *is* the edge A→B, so the handoff graph
is a query rather than a scan.

### 3.3 The fixed `kind` vocabulary

`kind` is a closed enum; `type` beside it is free-form. Comparing trajectories
across harnesses is the entire point, and a Claude Code tool call and an OpenHands
tool call have to land in the same bucket or cross-harness analysis degrades into
string-matching on someone's private event names. `custom` keeps the vocabulary
from having to be complete.

Orchestrator-level events (routing, fan-out decisions) hang off a session too —
the orchestrator opens one for itself. Every event belongs to exactly one chain;
there is no second, run-level append path to keep consistent.

## 4. Closing a run

`POST .../runs/{id}/close` takes the final git sha, resolves it against the
repository (a run closing against a commit nobody has is a claim nobody can
check), and signs an attestation binding that sha to each session's chain head
plus a `trajectoryDigest` over all of them.

**Closing also closes every still-open session, and that is load-bearing rather
than tidy.** The attestation names each chain head; a session that could still
append afterwards would leave an attestation that no longer describes the
trajectory. Verification failing for an honest reason is worse than not verifying
at all. Appending to a closed session returns 409, and joining a closed run
returns 409.

Re-closing on the same sha is idempotent; a different sha is a 409.

## 5. The eval, and why it is not a new evidence path

An eval **is** a gate result. `recordEval` writes an ordinary row into
`gate_results` with a DSSE envelope, so land policy, `gh pr checks`, the evidence
bundle, and candidate-set `best_score` all consume it through paths that already
exist. The `evals` row is the run-scoped projection of that, and the FK to
`gate_result_id` is the statement that there is one evidence path, not two.

The signed predicate binds, in one statement: the score, the commit, the run, the
intent, the `trajectoryDigest`, and the `specDigest`.

`specDigest` is what makes "deterministic" checkable rather than an adjective:
two results for one commit with different spec digests were not produced by the
same eval, and comparing them as if they were is how an eval-gated queue lands
the wrong winner. It is a canonical-JSON digest (`core/canonical.ts` — key order
must not change a hash anyone re-derives), or a digest the caller supplies if its
harness already content-addresses its suites.

`gate_results.reporterId` already recorded who reported a result, so the run,
eval-list, and verify responses project it as `reporter_principal` alongside
`separately_authorized` — true when the reporting identity is not the identity
that opened the run. A run that scores its own work is a self-report, and the
difference between that and an independently reported score is the difference
between evidence and a claim. ADP does not refuse self-reports; it refuses to
let them look like something else.

`gate_name` defaults to `eval:<name>` and is overridable. Reporting under the
literal name `score` feeds a candidate set's `best_score` policy unchanged — a
50-way fan-out where the winner is chosen by attested eval score needs no new
resolver code, which is the payoff of not building a second evidence path.

## 6. Reading it back

- `GET .../runs/{id}/trajectory` — merged across sessions in the order things
  actually happened, `occurred_at` with `(session_id, seq)` as the tiebreak so a
  merged view is stable when two agents report the same millisecond.
- `GET .../runs/{id}/stats` — counts and tokens by kind, per-tool call/failure
  counts, per-model spend, the handoff graph, the commits produced.
- `GET .../runs/compare?intent_id=` — **the optimization table.** N runs against
  one intent, each pairing an attested outcome with what the trajectory cost to
  produce it. Ranked by score descending, unscored runs last: unmeasured is not
  the same as scoring zero, and sorting it as zero would quietly invent evidence.
- `GET .../runs/{id}/verify` — recomputes every chain and checks the attestation
  against it. Tamper-evidence nobody can check is decoration; this makes the
  guarantee falsifiable by any holder of a read token, and reports *where* a chain
  broke by seq, because "the chain is broken" is not actionable.

MCP mirrors the read side (`adp_run_trajectory`, `adp_run_stats`,
`adp_runs_compare`) plus `adp_trajectory_append`. An agent reading its own run
back is the first consumer that makes the write cost worth paying.

## 7. Idempotency, because emitters retry

A batching emitter retries. `client_event_id` is deduplicated **before** chaining
— dropping a duplicate afterwards would leave a gap in `seq` — so a retried batch
produces exactly the chain the first attempt did. Duplicates are **reported** in
the response rather than silently absorbed: an emitter re-sending a batch it
already landed has a bug, and silence would let it stay one.

Appends serialize on the session row (`select ... for update`), the same pattern
checkpoint sequencing uses, because `seq` and the chain head are both
read-modify-write.

### 7.1 Completeness, because emitters also drop

Idempotency and completeness are different guarantees, and `client_event_id`
only buys the first. A retried event is deduplicated because it carries an id
ADP has already seen — but **an event that never arrived has no id to
deduplicate**. Nothing in the chain distinguishes "the agent made four tool
calls" from "the agent made five and the fourth was lost in a dropped batch".
Every hash still verifies, because the chain vouches for what ADP was given, not
for what it should have been given.

So an emitter may number its own events: `producer_seq`, contiguous from 1 per
session, assigned at enqueue rather than at send, with `producer_id` recording
who was counting. Appending a batch that skips a number is rejected whole with
409 and `expected_next_seq` — the emitter's spool replays from there instead of
guessing, and a partially absorbed batch (which would leave the emitter unable
to say what ADP holds) never happens. The response carries `accepted_through`,
the high-water mark a spool trims against.

Three consequences worth stating, because each was a decision:

- **Untracked is not incomplete.** A session with no `producer_seq` is
  `emitter_tracked: false`. Emitters that do not count are still first-class;
  reporting them as gaps would make the field noise, and a field readers learn
  to ignore is worse than no field.
- **All-or-nothing per batch.** Half a counted batch would leave a hole in the
  emitter's own numbering that it could never explain.
- **One writer per chain.** `producer_seq` is unique within a session, matching
  the single-writer rule the hash chain already depends on. Multi-writer chains
  keyed by `(session, producer, seq)` were considered and rejected: serializing
  one appender is what makes the chain a chain.

`verify` reports both guarantees separately (`chains_ok`, `emitters_ok`) and
fails `ok` if either does — the e2e test forces a gap with a *correctly chained*
row precisely to prove the second check is load-bearing rather than riding on
the first.

The hash covers `producer_seq` and `producer_id`, so the counter cannot be
rewritten to hide a gap. It covers them **by omitting the keys when they are
null**, which is why `v` stays `1`: rows written before these columns existed
hash exactly as they did, so adding completeness to the protocol did not
retroactively convert an untouched corpus into a tampered one.

## 8. What this does not do

- **No sampling, no truncation, no retention policy.** A long-running fleet will
  want all three. Nothing here forecloses them, but nothing implements them.
- **No object store for large payloads.** `payload` is jsonb in Postgres.
  `docs/pragmatic_mvp.md` §the-storage-table already earmarks S3-compatible
  content-addressed storage for trajectories; the migration path is to store a
  digest and a key, which the hash chain already accommodates because it hashes
  the payload it was given.
- **No automatic emission.** ADP is the receiving end, exactly as it is for gates:
  it does not run evals and it does not instrument harnesses. The orchestrator
  emits.
- **No trajectory-derived land policy.** Nothing yet blocks a merge because a
  trajectory looked wrong. The evidence is in place for it; the policy is not.

## 9. Test coverage, and the standard it is held to

`docs/m3-readiness-review.md`'s lesson governs: the check is not "does the
criterion have a test" but **"does the test exercise the scenario in the
criterion's own words, or a neighbouring one that was easier to set up?"**

`server/test/e2e-run-trajectory.test.ts` walks the capability statement in §1
literally — a real assignment as an issue, three agent sessions, all six event
kinds, a real handoff edge between two sessions, a real commit pushed over HTTP
whose sha the run closes against, an eval reported and then read back through the
*ordinary* gate and evidence-bundle endpoints. It also covers the paths that only
matter when something goes wrong: crash-and-rejoin, retried batches, appending
after close, closing against a commit the repo does not have, and a tampered
projection column detected at the right seq.

`server/src/core/trajectory.test.ts` covers the hashing properties as unit tests,
including one case per covered column — the assertion that the chain protects the
projection and not just the payload.
