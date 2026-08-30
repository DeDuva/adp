# Changelog

The rule a version carries: the git tag, the GitHub release, the published
image (`ghcr.io/deduva/adp`), the Helm chart's `appVersion`, the workspace
package manifests, `spec/openapi.yaml`, the newest entry in this file, and the
served `ADP-API-Version` all move together — `vX.Y.Z` tags a commit whose
`server/src/api-version.ts` says `X.Y.Z`. `scripts/dev/check-release.sh`
asserts every one of those on each push, and the release workflow re-runs it
before publishing an image. What a bump promises is defined in
[`docs/api-compatibility.md`](docs/api-compatibility.md); whether the operation
set moved with the version is enforced by `spec/operations.snapshot.json` and
its spec-coverage guard.

Until 2026-08-23 only one edge of that rule was enforced, and it was checked on
the tag push — after publication. Two contract bumps slipped through it.

## Unreleased

**A trajectory stores a payload's structure by default; full payloads are
opt-in per repository (#199).** #148 put the secret detector at this ingest
path, and that is a real reduction in blast radius — but a detector removes
what it *recognises*. This governs the larger surface: source no pattern
covers, customer data in a tool result, a prompt a human typed. Ambient capture
(#149) is what makes every connected session a producer of it, by default,
without anyone asking — so the default had to be decided before the recorder is
built against it. Decided now it is free, because nothing writes to these
tables yet; decided after #149 it is a migration and an apology, owed to
exactly the early adopters whose first trajectories were taken under the wrong
default.

**Structure means the shape, not a stub.** Under `trajectory.payloads:
structure` the stored payload keeps its objects, its arrays, its keys, its
numbers and booleans, and each string becomes `[adp:str bytes=N]` — the length
in UTF-8 bytes, which is the unit #146's ceilings already speak and the only
one a verifier that is not JavaScript reproduces. Everything that answers *what
did the agent do* is a typed column and is untouched: the kind, the tool name
in `type`, the outcome, the model, the token counts, the duration, the commit
sha, the handoff edge. A reader sees a `read_file` that returned 14 KB from
`$.output` and succeeded in 12 ms. They do not see the file.

**`payload_digest` is the commitment, and the chain covers it.** sha256 of the
canonical JSON of the payload as supplied, so a producer holding its own copy
can prove the record corresponds to it — "verified, payload not retained" as a
real verification state rather than a hole, which is the state retention
(`PLAN.md` 3-6) is built around. It joins `eventHash` on the terms `producerSeq`
and `redactions` set: omitted from the hash when null, so a `full`-mode event
and every row written before the column existed hash to exactly what they
always did. Null is therefore also the answer to "is this payload verbatim",
which is why there is no second column naming the mode.

One digest over the payload rather than one per string leaf, and that is a size
decision taken deliberately: a per-leaf sha256 costs ~89 bytes in place of each
string, so a payload of a few hundred short strings — a structured tool result,
a message array — would come out *larger* structured than whole. A default that
inflates the common case is not a default anyone keeps. What is lost is
leaf-level comparison, which nothing asks for yet.

**The asymmetry is the whole argument for making it the default**, rather than
any judgement about how much anyone should record. A repo widens to
`payloads: full` after reading what a trajectory holds; nobody unsends what
already arrived. A malformed `adp.yaml` needs no carve-out here — it leaves
this at `structure`, so failing closed and falling back to the default
coincide, which is the shape a default should have.

The projection runs **after** #148's redaction and before anything is chained.
After, because the digest has to name what `full` would have stored, and under
`on_secret: redact` that is the redacted text — a digest over the original
would be a durable commitment to the value #148 exists to keep out of this
table. The detector still runs and still records `redactions` under the
default, on a payload whose content is no longer kept: "a secret was in this
session" is a fact about the developer's environment they need to hear, and
that column is now the only place to hear it. #146's ceilings are re-checked on
the projected form, because "no stored event exceeds the ceiling" has to hold
unconditionally, and a payload built from thousands of very short strings is
the rare case where the projection is not the smaller one.

The walk itself is shared with #148 rather than written twice
(`core/json-leaves.ts`): two definitions of "where the strings are" would
drift, and the first payload shape one handled and the other did not would be a
silent hole in whichever was behind.

**Secret detection runs at the trajectory ingest path (#148).** ADP already
runs push protection at the wire: `pre-receive` computes the diff, ships the
text, and a regex-plus-entropy engine refuses the push naming the line and
pattern. That is the only in-tree detector by design, and it is well placed
for what it guards — **the diff**.

A trajectory is a different object. It records what the agent *read*: file
contents pulled into context, environment inspected, tool output returned,
prompts a human typed. A `.env` the agent opened and correctly decided not to
commit never appears in any diff and would appear verbatim in a `tool_call`
payload. Push protection cannot see it, because it was never pushed — and
under ambient capture (#149) the failure mode is durable, hash-chained, and
readable by anyone holding a `repo:read` token.

The same engine now runs at that second path, before anything is chained.
"Adapters, never scanners" is untouched: this is *where* the detector runs,
not a new detector.

**A redaction is recorded as a redaction.** The matched span is replaced by a
visible `[redacted:<pattern>]` marker — surgical, so what surrounded the
secret stays legible and the trajectory stays worth keeping — and the event
carries a `redactions` array of `{ path, pattern }` naming where and what
fired. Two facts rather than one: a reader should see that an event was
redacted without having to spot it in the text, and "which sessions hit the
detector" should not be a full-text search over every payload in the corpus.

**The chain commits to the redacted form.** Scanning happens before the hash,
never after, so what verifies is what is stored and a redaction cannot be
edited away afterwards. `redactions` joins the hash on exactly the terms
`producerSeq` set: the key is *omitted* when nothing fired, so every event
written before the column existed hashes to what it always did and
`verifyChain` does not report the whole corpus as tampered. The column is null
rather than `[]` for the same reason — an empty array is set.

**Per repository, `trajectory.on_secret` chooses `redact` (default) or
`refuse`.** The default is the decision, not a convenience: refusing loses the
trajectory, and a lost trajectory teaches a user to turn recording off — which
costs the record everything and costs the secret nothing, since it was already
on their disk. `refuse` is there for the deployment that would rather have the
gap, and is opt-in because only they can price that trade. A malformed
`adp.yaml` fails closed on *land* and deliberately does **not** fail closed
here: both modes remove the secret, so there is no safety to buy by refusing,
only a trajectory to lose. Failing closed is for a choice between enforced and
not enforced; this is a choice between two enforced outcomes.

**What this costs, stated plainly.** #146 kept the opaqueness invariant by
noting that measuring a size is not reading a value. This *does* read the
value — there is no way to detect a secret without looking at one. What is
preserved is the half that makes the protocol harness-neutral: nothing
branches on the payload's shape. The walker descends to the string leaves of
an arbitrary JSON value and scans each one, so a harness storing its own
format still needs no ADP change. Object keys are left alone: a key is
structure, and rewriting one would be indistinguishable from the harness
having written a different document.

The issue's related question — whether full payloads should be recorded by
default at all — is **filed as #199 rather than bundled here**. #148 governs
what a detector recognises; that governs what is stored when nothing is
detected, which is the larger surface and a different argument. It took #148's
place as the last thing blocking #149, and is the entry at the top of this
section.

**Trajectory payloads and checkpoint state are bounded (#146).**
`session_events.payload` and `checkpoints.state` are `z.unknown()` by design —
ADP never parses them, which is what makes the protocol harness-neutral rather
than harness-aware — and neither had a ceiling. The 2026-08-22 storage
analysis measured a mean of **833 B/event** across 1,930 real events and noted
that nothing prevented the **~85 KB/turn** the industry anchor suggests: a 20×
range with no upper bound. Harmless only because nothing writes to these tables
yet; the moment ambient capture (#149) ships, every connected session is a
producer and the first person to enjoy the feature is the first to fill their
own disk.

Three numbers, documented in `spec/openapi.yaml` so a producer can respect them
rather than discover them: **128 KiB per event payload** (~1.5× the industry
anchor, ~157× the measured mean), **1 MiB summed across a batch** (a full
1000-event batch at the measured mean is ~833 KB, so the realistic maximum fits
and the pathological one does not), and **1 MiB per checkpoint state** — the
batch allowance rather than the event one, because a checkpoint is a whole
harness's resumable state rather than one turn of it.

**Measuring a size is not reading a value**, so the opaqueness invariant holds:
nothing inspects the payload's shape, only what it will cost to store.

**Refused, never truncated, and never silently digested.** A truncated payload
that is still hash-chained is worse than a rejected one — it is a durable
record that looks complete — and for a checkpoint it would mean a DSSE
signature over a state the harness never wrote. The batch is refused *as a
batch*, before anything is chained, because `appendEvents` is all-or-nothing
and a refusal that let the earlier events through would leave a chain the
producer cannot reason about. Each refusal names the offending event by index
*and* by its `client_event_id`: an emitter retrying identifies its events by
id, not by position, and a refusal it cannot map back is one it cannot act on.

The issue asked which of drop / reject / digest-substitute to pin, since the
recorder will be built against the answer. **Reject.** The digest option
belongs to retention (`PLAN.md` 3-6), where "verified, payload not retained"
describes a payload that *was* accepted and later aged out; using the same
state for one that was never accepted would make the one honest third
verification state ambiguous exactly where it needs to be precise.

One thing this found: **Fastify's default 1 MiB body limit sat below the batch
ceiling**, so an oversized batch was already being refused — by the transport,
with a bare 413 naming nothing. That is precisely the "discover the limit
rather than respect it" failure the ceiling exists to remove, so the two ingest
routes raise their own limit to 2 MiB. The typed 422 is now what a producer
meets; the transport guard stays, an order of magnitude out, for anything
absurd.

With this, **every prerequisite of 1-7 is cleared** and `adp-recorder` (#149)
is unblocked.

**`operations` is indexed for the queries actually run against it (#147).**
The operation log is written in the same database transaction as every change
— a stated invariant — so it grows with everything else in the system. It
carried one index, on `repo_id` alone, while both of its readers filter *and
sort*. Every plan contained a `Sort` over the whole matching slice, and the
org audit export could not use the index at all.

Measured at 1M rows, reproducible with `make measure-ops`:

| Query | Before | After |
|---|---|---|
| history: repo + sort | 46.3 ms / 19353 blocks | **0.1 ms / 23** |
| history: repo + verb + sort | 48.5 ms / 19321 blocks | **2.2 ms / 1134** |
| history: repo + actor + since | 46.3 ms / 19321 blocks | **0.2 ms / 197** |
| export: the org's operations | 73.8 ms / 21367 blocks | **4.2 ms / 8211** |

Two indexes, `(repo_id, created_at DESC, id DESC)` and
`(org_id, created_at DESC, id DESC)`: the leading column is the always-present
predicate and the rest is the sort key, so each reader's filter and its
`ORDER BY` become one ordered walk that stops at `LIMIT`.

**The fix the issue proposed for the export does not work, and that is worth
recording.** It suggested restructuring `repo_id IN (…) OR org_id = …` into
two indexed reads unioned. Measured: 71.8 ms against 73.8 — no improvement,
because Postgres will not turn `repo_id = ANY(…)` into an *ordered* scan; one
index walk cannot yield rows for many leading-column values in sorted order,
so the planner falls back to a sequential scan and a sort of the whole table.

What works is a **LATERAL**, which gives each of the org's repos its own
`repo_id = <const>` walk that the new index serves directly and `LIMIT` stops
early — R+1 bounded reads, merged and re-limited.

**The faster answer was tried and reverted, and that is the more useful
finding.** Carrying `org_id` on every operation makes the export a single
indexed read: 17 blocks, against the LATERAL's 8211. It is also wrong here.
`operations.org_id` carries a foreign key, so filling it on every row makes
every operation insert take a `FOR KEY SHARE` lock on the org — *one row per
tenant*, on the write path of every push, merge and gate result. Against
`repos`, whose foreign key the same insert already locks, that is a lock-order
inversion: `e2e-candidate-fanout`'s 50-way workspace fan-out deadlocked on it
immediately, and would have gone on doing so in production under exactly the
concurrency this project is built for. The schema is unchanged, there is no
backfill, and the export still goes from 73.8 ms to 4.2.

**Deliberately two indexes and not four.** A third on `(repo_id, verb, …)`
measured 2.2 ms → 0.2 ms on the selective-verb history query — a real
improvement on an already-acceptable number, bought with permanent write
amplification on the hottest write path in the system. Recorded rather than
taken, so it can be revisited with the ingest numbers 3-5 (#195) produces
instead of re-argued.

**Both readers gained a keyset cursor**, the same idiom and the same
`ADP-Next-Cursor` header every other native-plane list uses. The sort key
gained `id` as a tie-break, which is the load-bearing half: operations written
in one transaction share a `created_at` to the microsecond, so paging on the
timestamp alone either repeats them or skips them. Both tests seed rows
sharing an instant and assert a full paged walk equals the unpaged one, with
no duplicates. On a `path`-filtered request the cursor marks the last
operation *examined* rather than the last returned — path matching happens
outside SQL, so a page can stop before the end of the rows it fetched, and
resuming from the last match would skip everything in between.

`server/scripts/measure-operations-plans.mjs` ships with it, behind
`make measure-ops`, so the numbers above are reproducible and the next person
to touch these indexes can re-run rather than re-argue. Its seeding is
deliberate in two ways the first attempt got wrong: repo, actor and verb are
assigned randomly rather than by modulo (which correlated them, so the
"selective verb" shape was measuring a query that could never match), and
verbs are skewed 90/10 toward one hot verb, because a uniform distribution
makes every filter look selective and flatters the index.

**Arm 2 re-run: the native plane's cost gap is gone at pilot scale.** The
benchmark's whole job is to gate our own investment, and its most
uncomfortable number was first-party: ADP-MCP at **$0.1435/trial** against
$0.0848 via `gh`, with *every* MCP trial costing more than *every* `gh` trial
— a clean separation, not a tendency. The leading hypothesis was that the
native plane had no tool to open a proposal, so an agent paid a
hand-assembled `curl` where `gh` spends one command. #144 added the four
tools. This is the re-run that tests it.

| | baseline (2026-08-10) | post-144-tools (2026-08-30) |
|---|---|---|
| ADP-MCP | $0.1435 | $0.0892 |
| ADP via `gh` | $0.0848 | $0.0771 |
| GitHub + `gh` | $0.0850 | $0.0710 |
| MCP : `gh` ratio | **1.69×** | **1.16×** |

**The hypothesis held.** But the honest statement is narrower than "the gap
closed", and the report computes rather than asserts it: in the baseline the
two ADP arms' per-trial cost ranges did not overlap at all, and now they do.
The residual 1.16× is a direction, not a separation — at four trials a cell
the arms are no longer distinguishable. That is weaker than a win and stronger
than nothing changed, and bounding what is left needs the study-scale
replication this report has always said it is not.

**The fallback was available and untouched.** `curl` stayed on the `adp-mcp`
tool list and unadvertised, and was used **zero times in twelve trials**. That
matters more than the cost figure: it means the residual is what the native
plane costs when its own tools are the ones being used, not an agent quietly
reaching past them. What is left looks structural — opening a candidate set
and resolving it are two MCP round trips with no single `gh` command standing
in for them, which no additional tool removes.

Every arm got cheaper between cohorts (`adp-gh` −9.1%, `github-gh` −16.5%),
which is why the ratio and not the absolute is the headline: cohorts ran on
different days and a vendor-side model change between them is invisible from
here.

**Run records are cohorted rather than pooled.** A second run dropped into the
old pile would have been averaged with the first, producing a mean describing
neither and destroying the only comparison the re-run exists to make. Records
carry a `cohort`; the report groups by it, never pools across it, and keeps the
earlier cohort rather than replacing it — a benchmark that overwrites its own
baseline cannot show that anything changed. Records without the field are the
original pilot.

Two setup differences are recorded on the report's own page rather than
smoothed over: the re-run instance ran today's default land-policy floor, so
`one_approval` was not actually enforced while the instructions still said it
was (enabling it was not an option — since #121 it is author-independent and
these arms are single-principal, so every ADP trial would have failed to land);
and the per-method `--allowedTools` list turns out to be a slightly leakier
boundary than it reads as. Neither moves the `adp-mcp`:`adp-gh` comparison,
because both ADP arms are affected identically.

**Arm 2 keeps its escape hatch, and records when the agent uses it.** #144
gave the native plane the four tools an agent needed and rewrote the `adp-mcp`
instructions to name them. It also pulled `Bash(curl *)` off that arm's tool
list, which the issue did not ask for and which was the wrong call twice over.

It makes the re-run a two-variable change: four tools appeared *and* an escape
hatch closed, so a cost drop could not be split between "the tools are
cheaper" and "the agent can no longer spend turns on HTTP it was told to
assemble". And a withdrawn hatch turns a step the tools still fail to cover
into a *failed trial* rather than an observation — which loses exactly the
finding worth having.

So `curl` is back on the list, and unadvertised: the instructions teach the
MCP path and never mention it. What makes that safe rather than sloppy is
that a fallback is now visible instead of invisible. Every trial records
`measurement.toolBreakdown` — per-tool counts, with Bash calls labelled by the
program they actually ran, so `Bash(git)` and `Bash(curl)` are different facts
— and `measurement.escapeHatchCalls`, a deliberately separate count of raw
HTTP invocations. Separate because it is the one signal the re-run has to read
at a glance, and burying it in a per-tool map would repeat the mistake of
burying it in a total.

The count is by *invocation*, not substring: a `curl` behind an `&&` counts,
`git log | grep curl` does not. It is a signal rather than a proof — an agent
holding `Bash(node *)` could reach HTTP through `node -e` unseen — which is
why the breakdown ships beside it instead of instead of it.

The published pilot records predate both fields, so the report says
**"fallback use is not measured in these trials"** rather than rendering a
zero. Those trials were *instructed* to use `curl`; a zero would be positively
wrong, and reading absence as zero is the same class of error as a skipped
test that exits green.

**The evidence bundle names the intent by title, and release 1a is complete
(#189).** `PLAN.md` 1a states its exit criterion as "a commit pushed by a
plain `git push`, from any harness, resolves to its intent, and the evidence
bundle names that intent **by title**". The first half shipped with #142 and
#143. The second did not: `getEvidenceBundle` returned `intent_id` and nothing
else about the intent, so a reader holding the artifact the whole product
points at could not answer "what was this change for" without a second round
trip against a route they had to already know existed.

This was nobody's issue. It is what was left standing when the six that 1a did
track — #141, #142, #143, #144, #145, #158 — all closed: the criterion the
section is measured by, which no item in it was about.

`change.intent` carries `{ id, title }` beside the `intent_id` that was
already there, so nothing generated against the old shape breaks. Title only,
deliberately: a bundle is read to answer why a line exists, and a title
answers that, while the body is the intent's own record and belongs behind its
own read rather than inflating every bundle for a question most readers are
not asking. It is `null` on an unbound change — an ordinary state, not an
error, and one the bundle now answers rather than leaving to inference. The
MCP `adp_evidence_get` tool inherits it for free, being a thin wrapper.

**Checked rather than asserted.** The acceptance walkthrough's B4 now pushes a
commit carrying an `ADP-Intent` trailer — plain `git push`, no ADP API call,
which is the whole point of the trailer — and C10 fails unless the bundle it
reads back names that intent by title. So the exit criterion for this release
is one assertion in the §2.1 walkthrough rather than a claim in a planning
document, which is the difference between a criterion and a hope.

**A persistent local instance, with a certificate `gh` will accept (#158).**
`gh` refuses plain HTTP for any host but github.com and no override exists, so
the GitHub-compatible plane — the whole point of the compat surface — could
not be exercised against a local instance without a real certificate. The
manual test plan called doing that by hand "the fiddliest part of the
walkthrough".

The machinery already existed, three times over: the acceptance suite,
the conformance run and `make demo` each mint a throwaway certificate and run
a proxy in front of the server, with port selection below the kernel's
ephemeral floor and log-line readiness rather than port probes — both of which
exist because something failed in a way that cost a debugging session. All
three were test fixtures. A person setting up an instance they could come back
to got none of it.

```bash
make local            # up, idempotent, prints how to reach it
make local-down       # stop, keep the data
make local-destroy    # stop and delete the data
```

It brings up Postgres on a named volume, the server from source, and the TLS
proxy, then prints the token, the URL, and the trust-store command for the
platform it is running on — per-tool (`SSL_CERT_FILE`, no root) and
machine-wide, including the extra import a browser on the Windows side of WSL
needs. `.adp-local/env` carries `GH_HOST`, `GH_ENTERPRISE_TOKEN` and
`SSL_CERT_FILE` ready to source, at mode 600 and gitignored.

**The demo/instance split is the point.** `make demo` is ephemeral by design
and correct to be; the gap was that a visitor who liked it had nowhere to go
but the Helm chart. This is the same server, the same proxy and the same
bootstrap with a longer lifetime, rather than a separate code path with
different affordances. Three things follow from "persistent" rather than being
decoration on it: the ports are fixed, because `PUBLIC_URL` is part of the
signed record rather than a display string; the certificate is good for 825
days rather than one; and **the signing key is minted once and kept**, because
it is what every signature in that instance's history verifies against and an
instance that rotated it per restart would silently orphan every change
already landed on it.

`deploy/docker-compose.local.yml` is a third compose file and the middle case
between the two that existed: a named volume and a fixed port, unlike the
ephemeral test stack, with no server image and no `restart:` policy, unlike
the production one. Its project name sits deliberately outside
`verify-clean.sh`'s `adp-test-*` sweep — it is not leaked state, it is state
someone asked to keep. `server/tls-proxy.mjs` moved out of `conformance/` for
the same reason: a supported mode must not depend on a file that lives in a
test tier.

**Not a production TLS story**, and `docs/self-hosting.md` §3b says where the
line is rather than blurring into it. Self-signed for `localhost`, because no
CA will ever issue for `localhost`; server from source under your own user; no
ingress, no backup, no second replica.

`scripts/dev/local-smoke.sh` drives all of it in CI on every push — up, `gh`
reaching it over TLS, a refused merge, a gate, a landed change, a stop, a
restart, and the evidence bundle read back from the restarted instance. The
restart is the assertion that matters: a supported mode nobody runs is a
supported mode that rots, and "the data is still there" is exactly the
property a script can lose silently.

**One thing this found:** `gh repo create` does not work against ADP and the
README said it did. It resolves the owner through `GET /api/v3/users/{owner}`
before creating, and that route is not served — which is why every harness
here creates repositories with `POST /api/v3/repos/{owner}` instead. The
compatibility table says so now.

**The native plane can open, review and merge a proposal (#144).**
`server/src/mcp/server.ts` registered 17 tools covering workspaces, the
operation log, undo, evidence, candidate sets, sessions, checkpoints,
trajectories, runs and evals — and nothing that opened, reviewed or merged a
proposal. An agent driving ADP through the native plane had to break out to a
raw `curl` mid-task, which the project's own benchmark instructions spelled
out at length. That is the leading hypothesis for the measurement that
contradicts our own bet: **ADP-MCP at $0.1435/trial against $0.0848 via `gh`
and $0.0850 on real GitHub** (arm 2, pilot scale, n=12). `gh pr create` is one
command; the native plane's equivalent was a hand-assembled HTTP request the
agent had to be told how to build, in a prompt, correctly, every time.

Four tools, thin wrappers over the REST routes that already exist — same
discipline as every tool beside them, no domain logic in the MCP layer:
`adp_proposal_open` (including `candidate_set_id`, so a candidate joins its
set at creation, the only moment it can), `adp_proposal_review`,
`adp_proposal_merge`, and `adp_intent_get`. The fourth is not on the issue's
list and is what its exit criterion actually needs:
`docs/api-compatibility.md` states plainly that the native plane is not
self-sufficient — nothing under `/api/adp` mints an intent, and an issue is
where one comes from — so closing the proposal loop while leaving that open
would have left the benchmark instructions carrying a `curl` regardless.

These wrap `/api/v3` rather than `/api/adp` because that is where the routes
are: a proposal *is* the GitHub-shaped object and an intent comes from an
issue, so a second native spelling of either would be a fidelity problem
rather than a feature.

**The refusal shape matters more here than anywhere else.** A refused land is
the one response an agent is guaranteed to see on a well-configured instance,
and an agent that cannot read it burns a turn guessing. `adp_proposal_merge`
returns the typed policy result intact — each unmet requirement with what is
missing and the command that satisfies it (#145) — rather than flattening it
to `message`, which says "Land policy not satisfied" and nothing actionable.
`adp_candidates_resolve` lands its winner through the same land path, so it
surfaces the refusal the same way now too.

`bench/arms/three-way-cost.mjs`'s `adp-mcp` instructions no longer contain a
`curl`: they name the four tools instead of teaching the agent to
hand-assemble HTTP. `Bash(curl *)` stays on that arm's tool list, unadvertised
— see the entry below on why an escape hatch that is available and *visible*
beats one that is absent. **The arm has not been re-run**: it is agent-backed, needs real tokens and a
real GitHub PAT, and runs out of band rather than in CI. Per this harness's
own contract an arm that was not run is reported as not run, so
`bench/report/three-way-cost.md` now says on its own page that its published
figure predates this fix and that the re-run's result will be published
whichever way it points.

**A refusal names the command that satisfies it (#145).** The refusal is the
product — `make demo` is built around reaching it, and the manual test plan
calls it out as worth doing deliberately: *"a policy that has never been seen
to refuse anything has not been tested."* Until now that moment produced a
typed `422` listing unmet requirements, which is correct and one step short:
the user was told `one_approval` was unmet and left to work out what to do
about it, which for a first-time user means going back to the documentation at
precisely the moment the product was about to prove itself. The repo already
has the opposite instinct elsewhere — an unimplemented REST endpoint 404s
*naming the ADP equivalent*, on the stated reasoning that "a broken call that
explains itself costs an agent one turn; a hang or a 500 costs it the
trajectory". This is that argument applied to the happy path.

Every unmet requirement now carries a remedy: what is missing, what to do, and
— where one exists — the literal command.

```
one_approval: no approving review → have a principal other than the author
  approve it — as that principal, run: gh pr review 1 --approve
gates_green: test not reported for b55529b → gates run on push — check a
  runner is up (`adp runner`), or report one: adp gate report --repo
  acme/widget --sha b55529b… --name test --status success
```

Three things the shape insists on. **One entry per gate**, not per
requirement, because that is the grain the command is written at — "some gate
is not green" is the sentence the user already had. **A gate nobody reported
and a gate that reported failure are different refusals**, fixed by different
things, where before both read "not green". And **no command is invented where
none exists**: a red gate carries a remedy sentence and no command, because
offering `adp gate report --status success` there would teach a first-time
user that the gate is a formality. The confidence bound is the same case.

It applies on **both merge paths**. REST and GraphQL are stated to enforce
identically, so they explain identically — and GraphQL is the path `gh pr
merge` takes, which is where most people will read a refusal at all, so a
remedy living only in the REST body would be invisible to exactly that
audience. The acceptance suite asserts the remedy text on both, including what
`gh` prints.

`unmet` keeps its shape, an array of strings, and each string now carries its
own remedy — error prose is explicitly not contract, and a caller that only
prints the line has the whole answer. `unmet_detail` is additive: the same
facts with the seams left in, for a caller that wants the command without
parsing a sentence.

**`make demo` shows the refusal rather than describing it**, through `gh pr
merge`, and asserts both remedies appear. Doing that surfaced a second defect:
the demo repo declared no gates, so `gates_green` was satisfied vacuously and
the refusal every line of its narration is about ("no gate has reported") was
really about the approval alone. The demo commits an `adp.yaml` naming its
gate now, so the beat it is built on is the one it actually performs.

**One `changes` row per sha, and a deterministic evidence read (#143).** Three
individually defensible facts were jointly a bug. `post-receive` auto-records a
signed change per new commit with a null intent (#142); `POST
/api/v3/repos/{owner}/{repo}/changes` — the documented way to record a change
*with* an intent — inserted unconditionally; and `changes` carried an ordinary
index on `(repo_id, git_sha)` rather than a unique constraint. So the
documented path to an intent-bound change, push then bind, left **two rows for
the same sha**: one auto-recorded and unbound, one explicit and bound. Then
`getEvidenceBundle` selected with no `ORDER BY` and no `LIMIT`, so which of the
two backed the evidence bundle — and therefore whether the bundle showed the
intent at all — was not pinned by the code. The index that made the lookup fast
made the plan likely to be stable in practice and no less unspecified.

`(repo_id, git_sha)` is unique now, and the route is an upsert: a call for a
sha the push already recorded *completes* that row, filling in `intent_id` and
`workspace_id` and **re-signing** — the signature covers `intent_id`, so a row
that gains a binding must gain a signature over the binding or the two
disagree. The provenance of an existing row is left as recorded: it names what
produced the commit, and this call is a binding, whose actor belongs in the
operation log — where the update is now recorded as `change.update`, with a
`before`, exactly as the create already was.

**Rebinding is refused, not performed.** A change whose intent moved would mean
the signed record said one thing yesterday and another today about the same
commit, verifiably both times, which is worse than having no signature at all.
Filling a null is not rebinding — it is the second half of a sequence that was
always meant to produce one record — so re-posting the same intent is a no-op
success, while a *different* non-null intent (or workspace) gets a typed `409`
naming what the sha is already bound to. `docs/api-compatibility.md` prices
tightened validation as a major bump; this is deliberately taken as a bug fix
instead, because the request it now refuses did not previously succeed at
anything — it produced two rows for one sha and an evidence bundle that chose
between them unordered. The status code for the working path does not move:
`201` on create and on completion alike, since flipping the documented
push-then-bind sequence to `200` to report an implementation detail of a fix is
the one part of this that *would* be a major break. `created_at` distinguishes
them for anyone who needs it.

The migration resolves existing duplicates rather than failing the deploy on
them — the opposite call from 0025's, and for a reason: there, duplicate repos
could have history hanging off both ids and choosing between them was an
operator decision, whereas here the duplicates are a known shape from a known
bug and the survivor rule is the one the fixed code applies. The bound row
wins, ties break oldest-first, and the one FK into the table
(`proposals.change_id`) is repointed at the survivor before the delete. It is
proven against a database that already holds duplicates: a throwaway database
migrated to the state before this migration, seeded with the exact shape the
bug produced, then migrated the rest of the way — running the migration that
ships rather than a transcription of it.

The push recorder gained `ON CONFLICT DO NOTHING` for the race its pre-flight
dedup cannot close. Two pushes carrying the same commit could both read "not
recorded"; before, that made a duplicate, and after the constraint it would
raise inside the one transaction covering the whole batch — discarding the
records for every other commit pushed alongside it.

**Token mint carries `harness`, `model` and `session_id`, so signed provenance
can name them (#141).** `README.md` promised provenance carrying "the pushing
identity, plus harness / model / session where supplied", and three of those
four were unreachable over HTTP. Everything else existed: the columns, the
`mintToken()` options, the `authenticate()` reader that puts them on the
identity, and the `provenanceOf()` that copies them into the signed block.
`POST /api/adp/tokens` accepted none of the three, and its only other caller —
`bootstrap.ts` — sets none, so every token in existence held null for all three
and every signed change omitted the fields that make its provenance worth
having.

The three are optional fields on the mint body now, echoed back in the response
so a caller can confirm what it was issued rather than minting blind — they are
unreadable afterwards except by using the token, and a typo in `harness` is
otherwise invisible until a signed change carries the wrong one. The
`token.mint` operation records them too, still without the token itself.

The grain question the fields raise is answered in the route rather than left
to the next reader: `model` on a *token* says which model the integration this
credential belongs to is built around — "this is the Codex integration's
token". It is not a claim about which model produced a particular attempt,
because a harness can switch models mid-session and the credential outlives the
switch. That claim is `runs.labels`, per attempt. Both, not either.

**Additive**: new optional request fields and new response fields, so a client
generated against 0.5.0 keeps working untouched. An e2e test drives the whole
chain — mint, authenticate, provenance, signature — and verifies the signature
over the provenance that names all three, because every field was already
present at every other step and a partial revert would otherwise type-check.

**A fresh instance floors at `gates_green` alone (#174).** `LAND_POLICY_FLOOR`
defaulted to `gates_green,one_approval`, and since #121 that second
requirement is author-independent — so the default handed a developer
evaluating ADP alone a refusal they structurally could not satisfy. They are
the only principal, and the requirement exists to constrain the person trying
to satisfy it. Because the three policy levels union, nothing below the
instance could drop it either: the only way out was an admin-owned env var
documented in one table row. GitHub's own default for a fresh repository is
zero required approvals, so this was stricter than the incumbent for exactly
the audience least able to absorb it.

The refusal that carries the argument is untouched — a merge is still refused
while the change has no gate result, which is the beat `make demo` is built
on. `one_approval` becomes opt-in: one env var for an instance, one line of
`adp.yaml` for a repo, one line of the org floor for a tenant. The
deployments that want it are the ones that have a second principal.

Nothing about `one_approval` itself changes. An instance that sets it gets
exactly the behaviour #121 shipped.

**Behavioral, and it loosens rather than tightens**, so no client breaks and
no contract moves. An instance that wants the old behaviour sets
`LAND_POLICY_FLOOR=gates_green,one_approval` — as `make demo`, the acceptance
walkthrough and the conformance run now all do explicitly, rather than
inheriting a default their assertions depend on. The Helm chart's
`server.landPolicyFloor` default moves with the code so there is one default
and not two.

**The published site argues past the merge, and a third page walks the loop.** `make site`
asserted that the site *rendered*; nothing asserted that it argued the right thing, and read
cold the front page claimed only that agents write code and ADP checks it — a claim every
merge-blocking review bot can make, ending where the field data says the trouble starts. The
front page now covers what the record is for after a change lands and why it has to survive a
change of harness, and `docs/html/sdlc/` is a new page mapping the six-stage loop the
published agentic-SDLC playbooks describe against what holds each committed artifact today.
The essay reaches past the merge too: section 01 now says that verification is where the
queue is visible and deployment is where the failures land, and the alternatives it weighs
gained the one that is a practice rather than a product — a playbook is what says an artifact
should be written down, and cannot be the thing that refuses when it wasn't.
No capability claim moved: the front page's status table is still the only place that is
maintained. `make site` and CI's `site-runtime` job now drive three pages rather than two, on
the same exit criteria, so the new page cannot be published ungated.

**`one_approval` is author-independent.** An approving review from the
principal that authored the proposal no longer satisfies it (#121). A merge
that was previously allowed on the author's own approval is now refused with
the usual `422` naming `one_approval`, and landing under this floor takes two
principals.

This is a **behavioral change without a contract bump**, and the distinction is
worth stating rather than assuming. No request or response shape moved, and a
client generated against `0.5.0` still works unmodified: it still calls merge,
and still reads `unmet` off a `422`. What changed is the meaning of a policy
requirement, and land-policy outcomes were already a function of instance, org
and repo configuration rather than of the contract version.

It can still break an existing workflow — specifically a single-principal one,
which is exactly the workflow it exists to break. ADP's own acceptance,
conformance and `make demo` runs were three of them: each opened a proposal and
approved it as the same actor, so each now mints a second principal to approve
with. Anything scripted the same way needs the same change.

GitHub refuses self-approval at review time; ADP records the review and refuses
the *merge*, because the requirement lives in the resolved land policy rather
than in the review route — so every level that can name `one_approval` (instance
floor, org floor, repo `adp.yaml`) inherits the check, and both merge paths
(REST and GraphQL) enforce it through the one `landProposal` sequence.

**One design system for the published site (#163, second half).** The two pages were
written months apart by different means and shared no styles: the palette was declared
twice and identically, the container widths disagreed at `940px` against `1120/760/520`,
and the vertical scale was thirteen unrelated numbers with an inline `style=` at the one
place it ran out. Neither page responded to a breakpoint, neither showed a focus ring, and
both tables were unreadable on a phone.

`docs/html/site.css` now owns the palette, a seven-step type ramp and an 8-base spacing
scale for both pages. Neither page declares a colour or a static inline `style=`; the
essay's simulations reach their colours through `var(--sim-*)` tokens instead of the 91
hex and `rgba()` literals that used to live in its JavaScript, so the whole site restyles
from one file.

The direction is **"Blueprint"**: cool paper under a faint 24px grid, structure drawn in
1px black, section boundaries banded and numbered, figures set as numbered plates. It was
chosen from four drawn against the same content — Paper (warm, serif, narrow measure),
Instrument (the dark page rebuilt), Blueprint, and Inversion (ink on paper with full-bleed
dark figure bands) — and it won on the specific complaint: the page had no visible section
boundary and no scale, and Blueprint's whole grammar is drawn structure, so it cannot
quietly lose them again. `docs/html/site.css` carries the shortlist and the reasoning.

What a reader gets: rhythm and gutters that move on three breakpoints, prose tables that
stack into labelled records below 620px, a core diagram that stacks rather than becoming a
640px horizontal scroller on a phone, 44px touch targets, and a visible focus ring on every
interactive element. Text colours were picked against the paper ground rather than by eye —
every one clears WCAG AA, with separate tokens for marks, which only need 3:1.

Two inline styles survive by design, and only in the essay: a width or an opacity a
simulation computes per frame is state, not styling, and cannot live in a stylesheet. Each
is required to carry a `{{ hole }}`, which the test asserts.

`make site` drives both published pages in the pinned Chromium and asserts #163's exit
criteria — no horizontal scroll at 320, 375, 768, 1024 and 1440px, every table readable at
375px, a focus ring on every interactive element, one stylesheet owning the palette, and
nothing off-origin but Google Fonts. CI runs it in the `site-runtime` job. The criteria
stopped being things anyone had to check by looking.

No contract change; nothing under `server/`, `cli/`, `runner/` or `spec/` moves.

**The published site can rebuild what it serves (#163, first half).** `docs/html/support.js`
is 69 KB of generated JavaScript whose own header named a `dc-runtime/` that was in no
repository anyone working here could reach. It drives every interaction in the essay at
`/why/`, and nobody could fix, upgrade, or even read the source of it. #138 saw this and
confined it to the secondary page rather than resolving it; the decision taken here is to
vendor.

`dc-runtime/` now holds the source. It was recovered from the artifact itself — an
unminified `esbuild` bundle that had kept its module markers, identifiers and comments —
and the recovery is verified the only way that means anything: a fresh build reproduces the
previously committed file byte for byte, but for the banner and two pairs of redundant
parentheses that `bun`'s printer keeps and `esbuild`'s drops. `make dc-runtime` and CI's
`site-runtime` job rebuild and assert, so a hand-edited artifact fails rather than ships.

**The site no longer loads code from a CDN.** The runtime fetched React, ReactDOM and
`@babel/standalone` from `unpkg.com` on every page load. Because it hides the raw template
before loading anything, an unreachable unpkg produced a blank page, not a degraded one —
and it put two packages on a published site that this repository did not contain. React and
ReactDOM are now vendored under `docs/html/vendor/` by the build, from the pinned
dependencies, and hash to the same `sha384` SRI values the old code pinned for unpkg: the
browser executes the same bytes and only the origin changed. `@babel/standalone` is not
vendored — 2.8 MB reached only by JSX `<x-import>`, which neither page uses — and now fails
with an explanation instead of a network call. Google Fonts is once again the only external
asset either page loads.

No contract change; nothing under `server/`, `cli/`, `runner/` or `spec/` moves.

## v0.5.0 — 2026-08-23

Two contract moves reach a tag here. `0.4.0` was bumped in-tree when M4-5
landed and never tagged, released, or published as an image, so no consumer
could pin it; it ships inside this release rather than being retro-tagged, and
its entry is kept below verbatim. Both moves are additive — a client generated
against `0.3.0` is unaffected by either.

### 0.5.0 — the org storage quota

**M4-3: the per-org storage quota.** `orgs.max_storage_bytes` — the last of
the four org quotas, and the one the milestone never built. It was deferred to
M4-8 ("it needs the object store to meter against") while M4-8's own sizing was
deferred to it ("depends on M4-3's storage-quota shape existing to bound it"),
a deadlock that held for the whole milestone with nothing bounding how much one
org could write. It is broken from this side: the meter counts the bytes that
exist today — an org's rows in Postgres plus its git repos on disk — and gains
the object store as a third term the day there is one, without the ceiling's
shape changing.

Additive: `max_storage_bytes` joins the `PATCH /api/adp/orgs/{orgId}` body and
the `quotas` object on org detail. The latter is a wider shape than the three
counting quotas (`OrgStorageQuota`), because a measured `used` can be null and
carries the `measured_at` that says how stale it is.

Three behaviors worth knowing before setting a ceiling. **The meter is
sampled, not synchronous** — a ten-minute tick
(`STORAGE_METER_INTERVAL_MS`), because measuring is a full scan of the org's
rows in ten tables and cannot live on the trajectory hot path; that interval is
exactly the overshoot an org can achieve past its ceiling. **An org that has
never been metered is under quota, not over** — `storage_bytes_used` is null
until the first tick, and failing closed on null would refuse every write on
every instance for one interval after every restart. And **gate-job completion
is never refused**: the gate has already run, so refusing would wedge the job
until the reaper and leave its signed evidence unwritten, blocking any commit
under a `gates_green` policy — a storage quota turning into a land outage.
Instead the completion lands and its logs are dropped, with the drop recorded
on the operation so the empty `logs` reads as a decision rather than data loss.

Reads are never refused. An org at its ceiling can still clone what it already
has, because a quota that takes the data hostage is a lockout, not a ceiling.

New gauge: `adp_storage_bytes{org}`, the first storage metric this server has
had. `docs/observability.md` §5 amends its own "no per-org labels" position to
say why this one is the exception.

### 0.4.0 — OIDC login (shipped here, never separately released)

**M4-5: OIDC login (#103).** The standard authorization-code flow with PKCE,
mapped onto `identities` through a new `external_identities` table keyed on
`(issuer, subject)` — not on email, because Google's `sub` is the stable
identifier and an address that gets reassigned must not hand over an account.

Additive: two new operations, `GET /auth/oidc/start` and
`GET /auth/oidc/callback`. No existing operation changes shape, and both
routes are absent entirely on an instance with no IdP configured, so a client
generated against 0.3.0 keeps working untouched.

Two things worth knowing before enabling it. **Auto-provisioning is off by
default** — `OIDC_ALLOWED_DOMAINS` is empty, and empty means a verified
account with no existing link is refused rather than welcomed. And a login
mints `repo:read` + `repo:write` only; **`admin` is not reachable from the
login route by any input**, the same bound `POST /api/adp/tokens` carries.

ID tokens are verified against Node's own crypto rather than a JWT
dependency, with an allowlist of exactly one algorithm. The negative cases —
algorithm confusion, `alg: none`, unknown `kid`, tampered payload, wrong
issuer, wrong audience, expired, replayed nonce — are each a test, because
that is the only thing that makes the trade sound.

## v0.3.0 — 2026-08-14

The coordinated breaking contract release (#97), plus the full M4
post-landing-audit remediation (tracked in #87) — every fix its own PR carrying the audit's named
negative-case test.

**Security (P0).**
- Gate-job checkout/complete bind to the identity that claimed the job
  (#88) — previously any `runner` token could tarball any org's source and
  forge signed gate evidence.
- `repos(owner,name)` unique; `owner` validated against path traversal;
  `repos.org_id` NOT NULL and indexed (#89).
- `POST /api/adp/tokens` mints bounded tokens; `admin` no longer satisfies
  `runner` (#90).
- Org isolation enforced on every plane — REST, git http, GraphQL,
  `/api/adp` — with explicit, audited org provisioning and the
  org-isolation matrix test, M4 exit criterion #1 (#91).

**Queue reliability (P1a).**
- Claims are leases; a reaper requeues what a dead runner held, up to a
  retry cap, with operations recorded at every lifecycle transition, an
  `oldest_running_age` gauge, and an alert on the reaper itself (#92).
- `FOR UPDATE OF gate_jobs` — issue/PR numbering no longer starves the
  claim path (#93).
- All three org quotas enforce inside the transactions that consume them
  (#94). Completion and its signed evidence are one transaction (#95).
- Background writers (sweeper, reaper) take advisory locks — a second API
  replica is safe (#96).

**Contract (breaking).**
- `ADP-API-Version` 0.2.0 → 0.3.0, with an operation-set snapshot guard so
  the version can never silently not-move again.
- Every 4xx carries a shared `Error` schema; validation errors are a stable
  `{path, message, code}` projection, never raw validator internals.
- Auth and per-operation scopes declared in the spec (`x-required-scope`)
  and asserted against the code in both directions.
- Every list endpoint is bounded: `per_page`/`page` on the compat plane,
  `limit` + `ADP-Next-Cursor` keyset cursor on the native plane. The
  gate-jobs listing no longer inlines `logs`.
- Org administration (quota ceilings, policy repo, kill switch) has
  audited REST write paths, and org-level operations appear in the org
  audit-log export.
- The run/compare/verify/eval responses squad-lab consumes are typed.
- URLs keep `{owner}/{repo}`: the owner string is the org's immutable URL
  slug; org rename is unsupported pre-1.0 by design.

**Hardening & hygiene (P2).**
- Gate containers: `--cap-drop=ALL`, `--security-opt no-new-privileges`,
  `--pids-limit`, and a host-operator image allowlist
  (`RUNNER_IMAGE_ALLOWLIST`) (#100).
- The acceptance walkthrough runs in CI; `make runner` requires a real
  docker daemon; every self-skipping suite routes through the shared
  skip-into-failure guards (#99).
- `web/` runs tests in CI, with its hand-copied server enums bound to
  their sources (#98).
- This release identity itself: tag, GitHub release, published image with
  digest, `image:` in the compose file (#101).

## v0.2.0 — 2026-08-05

Runs carry `labels`; a compare row carries every named eval alongside the
single latest one. Additive.

## v0.1.0 — 2026-08-04

First versioned contract: runs, hash-chained trajectories, evals as gate
evidence.
