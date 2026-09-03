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

## Phase 0 — What 0.6.0 must not ship without

**Complete, in `fix/0.6.0-release`.** A first-run evaluation on 2026-09-01 cloned the repository
fresh from GitHub and ran every command the README, the published site and the tooling tell a new
user to run, in the order they tell them. It is the direct sequel to the 2026-08-24 evaluation that
opened Phase 1, and it found the opposite shape of problem: Phase 1's finding was that the substrate
was built and the bindings were missing; this one was that the bindings are built and **the path to
them was broken**. `make demo` — the one command the README, the landing page and the CI gate all
point a visitor at — failed eight seconds into a fresh clone, and three of the four surfaces that
greet a visitor described something that was no longer true.

Eighteen defects, all closed. What each of them was and what it cost is in `CHANGELOG.md` under
v0.6.0; this file records what is left, so the table is gone with them. The membership rule that
decided the phase is worth keeping, because the next release will need it: **a defect belongs in a
release phase if a stranger meets it before they have formed an opinion, or if it is a published
claim that is false.** Everything else, however real, waits.

Four things it settled that the next person should not have to rediscover.

**A gate that installs what a visitor would not is not a gate.** The CI `demo` job ran
`npm ci --prefix server` immediately before `make demo`, so the one check whose whole purpose was to
keep the visitor's path working was the only caller that never walked it — and it stayed green
through every fresh-clone failure. The comment above it said the job brings up its own Postgres
"because that is the path a visitor actually takes", one line below the step that made that false.
Where a check exists to protect a first run, the setup it is allowed is the setup the first run has.

**`check-release.sh` was watching four surfaces out of seven, and reported "consistent".** The site
said 0.5.0, the recorder package said 0.5.0, and the Compose stack deployed v0.3.0, all while the
script printed a pass. Three of the four blockers were that one gap. The lesson is not "add three
checks" — it is that the list of surfaces is itself a thing that rots, and that adding a package or
a published page to this repository includes adding it there. `recorder` was missing because it was
created after the script was.

**A published claim is a feature with no test.** The README promised that unimplemented endpoints
name their ADP equivalent; one route in the server did. The site promised a contract version; it was
a release behind. Both read as true for as long as nobody checked a second instance. Where prose
makes a claim the code can answer, the claim wants an assertion —
`server/src/http-rest/not-implemented.test.ts` and §3b of `check-release.sh` are those two.

**The constraint that shaped the 404 fix is worth remembering.** `spec-coverage.test.ts` fails when
the server serves a route the spec does not describe, so the answer could not be eleven families of
stub routes: that would have meant eleven families of spec entries for endpoints that do nothing, or
a hole in the guard. A not-found handler serves no route, appears in no route table, and changes no
generated client. Enriching an error is not the same as adding a surface, and only the second one is
a contract change.

**Exit criterion, met:** someone who has never seen this project clones it, runs the command the
front page gives them, and reaches the evidence bundle — without installing anything the
documentation did not tell them to, and without being told a version, a URL or a command that is not
true. Verified end to end from a clean `git clone`, twice.

### What it deliberately did not fix

**0-19 — `drizzle-orm@0.36.4` carries GHSA-gpj5-g38j-94v9** (high: SQL injection via improperly
escaped SQL identifiers), fixed in 0.45.2, which is a breaking upgrade across nine minors of the
data layer.

**Not exposed as written, and that is a finding rather than a dismissal.** The advisory's path is an
identifier built from untrusted input, and this codebase builds none: all seven `sql.raw` call sites
take a compile-time literal — `"o"`, `"ol"`, `"TRUE"` in `http-rest/audit-log.ts`, and a module
constant in `core/storage-usage.ts`. Every user-supplied value on those paths (`actor`, `verb`,
`since`, `until`, the cursor) is bound as a parameter.

It failed Phase 0's membership rule twice over — nobody meets it in the first five minutes, and no
published claim was false while it stood — and bumping the ORM nine minors inside a release-polish
branch is the kind of change that gets waved through on the strength of an advisory ID and then
breaks a query nobody re-read. It wants its own branch, its own full-suite run, and someone reading
drizzle's changelog. What this phase owed it is the analysis above, so that whoever picks it up
starts from "no reachable path, upgrade on the merits" rather than from a red `npm audit`.

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

**Release 1c is complete**, and the criterion is met the way 1a's was — by a path somebody can
walk rather than by a claim. From a landed commit: the intent that asked for it, by issue number
and title; the run that produced it; the session inside that run; the trajectory, with every typed
column rendered as the thing it is; and back again. Its table is gone with it, because this file
records what is left.

For the record of which number was which. 1-12 was `adp init`, #153 — one command against a
repository that already exists. 1-13 was the CLI's missing verbs, #155. 1-14 was the M3 surface
getting a reader at all, #156. 1-15 was making the record navigable in both directions, #157. 1-16
was the interim retention default, #161. 3-4 (#152), 2-2 (#159) and 2-3 (#160) landed here too and
are gone from their own tables. Their numbers are not reused, per the rule under 1a.

Five things the release settled or discovered that the next person should not have to rediscover:

**The exit criterion has a limit the record itself imposes.** The UI answers "what was this agent
*doing*" — the tool, its verdict, the tokens, the cost, the commit — and cannot answer what it was
*saying*, because under #199's default `trajectory.payloads: structure` the strings are replaced by
their byte counts before the event is chained. The view says which of the two it is showing rather
than rendering the projection marker as though the agent had uttered it. That default is right, and
it prices 3-6: the structural projection is already a retention policy for the most valuable
payloads, taken before anyone measured what retaining them would cost.

**"The chain verifies" was a weaker statement than this backlog assumed.** Recomputing a chain from
its genesis does not detect an edit made *consistently* — repair every hash behind the change and it
verifies. What pins the middle is a signature over a head the rewrite would have had to move, which
the checkpoints have held all along with nothing reading it. Verification checks them now, and that
turned out to be load-bearing for retention as well: a reduced payload's event can no longer be
re-derived, so a signed head past it is what keeps a wholesale rewrite detectable.

**Retention costs more than "payload not retained" suggests, and 3-6 has one fewer degree of
freedom.** An aged-out event's *typed columns* stop being independently verifiable too, because the
hash covering them covers the payload as well. "Attestations committing to digests never payloads"
was the intended shape; the digest is not what makes a reduced event verifiable, because the chain
commits to the payload through the event's own hash and not to the digest. 3-5's numbers still
decide the window and the tiering. They no longer decide the vocabulary.

**Open question 4 is settled: mirror is the default**, and detected rather than asked for. Native
mode asks a team to agree and mirror mode asks one developer to add a remote, and evaluation happens
at the second price and never at the first.

**A later decision overrode an earlier done-when, once.** #153 asked `adp init` to leave a running
gate runner behind; #155 then decided that a process mounting the Docker socket does not start
without being told this is the right host. The later one won. Attaching a repository is not an
instruction to hand root over the machine, so `init` says why it started none and prints the command
that would.

**2-3 is also the instrument for OD-3**, which is why it earned its place twice — and there is now
something to take to a harness team rather than an argument. `make demo` ends on the handoff: one
task, two harnesses, one continuous signed history, with nothing calling `checkpoint` or `resume` by
hand. Two streams go through `adp-recorder wrap` and `--continue` is the only instruction, which was
the ordering note's whole point: a demo driven by a script calling the API on the harnesses' behalf
is evidence that a script can call two endpoints, not evidence of portability. What it shows a
vendor is that a reader is ~200 lines in `recorder/src/readers/`, so `harness` stays a string the
server never branches on.

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

---

## Phase 5 — Companion mode: ADP underneath GitHub

**Why now:** a product review on 2026-09-02 walked `main` as a GitHub developer rather than as
an evaluator, and landed on a seam this backlog had not named. Mirror mode is the default because
Open question 4 settled it that way, and every claim made for it holds — GitHub's runners keep
executing the existing workflows, and their results arrive here as signed gate evidence
(`server/src/core/actions-ingest.ts`). The seam is what happens on either side of that:

> **The more faithfully a developer keeps GitHub as their workflow, the less of ADP's most
> interesting behaviour is authoritative.**

That is not a missing capability either. It is the same shape Phase 1 found, one level up: the
substrate is built, and mirror inbound binds almost none of it. `server/src/http-rest/mirror-webhook.ts`
handles two events — `push` and `workflow_run` — and skips the rest, so a repository whose issues,
pull requests, reviews and merges all live on GitHub hands ADP a stream of commits and CI verdicts
and nothing that says what any of it was *for*. Three consequences, each of which reads as a
separate defect and is not:

- **Land policy is unenforceable** where the merge happens. `evaluateLandPolicy`
  (`server/src/core/land-policy.ts`) is real and refuses correctly, and GitHub will merge without
  ever asking it.
- **`adp undo` does not cover a GitHub-native merge.** It resolves the `proposal.merge` operation
  that produced a SHA (`server/src/core/undo.ts`); mirror inbound writes `change.create` and never
  that verb. The one verb most worth having in the mode we tell people to adopt is the one that
  mode cannot reach.
- **Intent lives in a second namespace.** A team organising work in GitHub Issues gets an ADP
  intent universe beside it rather than under it, because `intents` has no column for an upstream
  identity.

**They are one defect.** Ingest the pull-request and issue lifecycle and all three close against
machinery that already exists and is already tested: a shadow proposal for a GitHub pull request is
something `evaluateLandPolicy` can be handed, something a merge webhook can close with a real
`proposal.merge`, and something `undo` therefore resolves. This phase is mostly ingest.

It is numbered 5 and **runs ahead of Phases 2, 3 and 4**, which is a claim about order rather than
about their worth: those are a differentiator, a durability measurement and three research
questions, and none of them changes whether anyone adopts. Numbers here are identity, not sequence
— the same rule that stops item numbers being reused under 1a.

**Every item below was filed on 2026-09-02**, as #224–#242 in item order, so this file's own rule
holds over the largest phase in it: `check-docs` compares each `#NNN` here against its real state,
and a phase whose items named no issue would have left that guard inert over exactly the work most
likely to drift.

### 5a — The record covers GitHub's own lifecycle

Exit criterion: a developer runs the whole loop on GitHub — issue, branch, pull request, Actions,
merge — types no ADP command, and afterwards `adp undo <sha>` works and the evidence bundle names
the issue by title.

| # | Item | Tracking | State | Why |
|---|---|---|---|---|
| 5-1 | `pull_request` ingest — a GitHub pull request becomes a shadow proposal carrying its upstream number and URL | #224 | shipped | Every other item in this release hangs off the proposal row existing |
| 5-2 | Merge ingest — a merged pull request writes a real `proposal.merge` operation | #225 | shipped | What makes `adp undo` reach a GitHub-native merge. The operation must carry the before/after state `undo.ts` reads, or it refuses for the second reason instead of the first — so it is established from one of three facts, or not written at all |
| 5-3 | `issues` ingest — a GitHub issue becomes an intent with an upstream identity | #226 | shipped | `intents` needs a column for the upstream reference; today `source` distinguishes `issue` from `api` but nothing records *which* issue, on whose host |
| 5-4 | `pull_request_review` ingest — a GitHub approval satisfies `one_approval` | #227 | shipped | Otherwise the policy in 5c refuses every mirrored pull request on a requirement GitHub already met, which is worse than not publishing it |
| 5-5 | Poll what a webhook cannot reach | #228 | shipped | Inbound needs a publicly reachable endpoint; `server/src/core/mirror-poller.ts` drains outbound only. A poller driving the same ingest functions needs no public URL, and is what makes companion mode work from a laptop. On by default, because the webhook is the optimisation and this is the floor |

**5-5 is the item that decides who can adopt at all, and it was nearly missed.** `adp init`
configures the mirror and then prints a webhook URL and a secret for a human to paste into GitHub's
settings, so until that is done by hand, inbound ingests nothing — the mode is configured, reports
success, and records only what an outbound push already knew. A developer without a public hostname
cannot do it at all. Polling is not a degraded substitute here; it is the only version of companion
mode that runs on the machine most evaluators have.

### 5b — Provenance is the same wherever a change arrives

Exit criterion: a change pushed through GitHub and the same change pushed to ADP directly produce
provenance blocks that differ only in `via`.

| # | Item | Tracking | State | Why |
|---|---|---|---|---|
| 5-6 | Carry `harness`, `model` and `session_id` through the push path | #229 | shipped | A defect against 1-1 rather than new work — see below. The invariant it buys is in `AGENTS.md`, where the next person changing a write path will meet it |
| 5-7 | Resolve the GitHub author to a real identity | #230 | shipped | Mirror inbound attributes every commit to `mirror:github:<owner>/<repo>`. `external_identities` is already `(issuer, subject)`-keyed and provider-generic (`server/src/db/schema.ts`), so a GitHub link needs no new table — and it landed ahead of 5-4, which cannot work without it |
| 5-8 | Observe the model rather than trusting the token's claim | #231 | shipped | A harness can change model inside one run, and the session events already record it per event. 2-4 prices a decision on this field; an asserted `--model` is the wrong thing to price it on. `core/observed-model.ts` is what 2-4 writes against |

**5-6 is a bug, and finding it is the argument for having reviewed the implementation rather than
the positioning.** `AuthenticatedIdentity` carries `harness`, `model` and `sessionId`
(`server/src/auth/tokens.ts`). `RecordActor` carries `id`, `kind` and `principal`
(`server/src/core/change-recorder.ts`), and `server/src/http-git/hooks.ts` passes only those three.
So a plain `git push` from a connected harness — the exact path 1b exists to make ambient — records
a signed change that does not name the harness that produced it. Only the explicit REST route sets
it (`server/src/http-rest/changes.ts`). The review read this as mirror mode having weaker provenance
than direct push; it is weaker than that, because **both** git paths drop it and only the route
nobody uses ambiently keeps it.

**The invariant this release buys, and the reason it belongs in `AGENTS.md` rather than only here:**
*how a change arrived must not determine the quality of its provenance.* It wants a test asserting
the two routes agree, because the failure mode is silent — the provenance block is present, signed,
and simply thinner, which no existing check can distinguish from a human pushing without a harness.

### 5c — ADP is visible, and enforceable, inside GitHub

Exit criterion: a pull request on GitHub shows what ADP knows about it, and a repository can make
ADP's verdict a required check without ADP becoming the merge authority.

| # | Item | Tracking | State | Why |
|---|---|---|---|---|
| 5-9 | A GitHub App, created from a manifest by the instance itself | #232 | shipped | Replaces the personal access token and the hand-made webhook 5-5 describes. The manifest flow keeps this available to a self-hosted instance: GitHub creates the App in the user's own org and hands the credentials back, so it needs no hosted control plane. It also unblocks 5-10 and 5-11, which a PAT cannot reach at all — GitHub's Checks API refuses one |
| 5-10 | Publish `ADP / change record` as a check run | #233 | shipped | Intent, producer, trajectory and evidence, on the pull request, where the work already is. This is the whole additive claim made visible |
| 5-11 | Publish `ADP / policy` as a check run | #234 | shipped | Branch protection then enforces it. GitHub stays the merge authority and will not merge until ADP agrees, which is the resolution of the seam this phase opens on |

**5-11 is the item that makes mirror mode's enforcement story true rather than aspirational**, and
it is deliberately a *check* rather than a merge gate of our own. Asking a developer to choose
between GitHub's merge plane and ADP's is the choice mirror mode exists to avoid; publishing a
verdict GitHub already knows how to require is the same enforcement with none of the migration.

### 5d — Distribution, and adapters that are boringly good

Exit criterion: `adp connect <harness>` is the last thing a developer types, for every harness that
has a reader.

| # | Item | Tracking | State | Why |
|---|---|---|---|---|
| 5-12 | Publish the CLI | #235 | shipped | `cli/package.json` is `"private": true` and the documented install is a source build, so ADP cannot currently be obtained without cloning it. Everything else in this phase is a bigger front door on a building with no road. It publishes as `@deduva/adp` on tag, and skips cleanly where no `NPM_TOKEN` is configured |
| 5-13 | A Gemini CLI reader | #236 | shipped | `adp connect gemini-cli` works and gets the commit-trailer half; turn-level trajectory is the documented degraded mode. Harness independence is the strategic claim, and two readers out of three connected harnesses is where it is measured |
| 5-14 | Connect finishes the job | #237 | shipped | Claude Code is told to add a `SessionStart` hook by hand; Codex leaves a wrapper the developer has to remember to invoke instead of their normal command. Both are `connect` stopping one step short of the thing it exists to do |
| 5-15 | Companion mode needs no ADP git remote, and no command infers one | #238 | shipped | `adp init` adds an `adp` remote and `adp connect` finds the repository by looking for it. That composes today, and it composes by coincidence: the repository's identity is *derived* from a remote rather than *recorded*, so renaming the remote breaks every subsequent command. In companion mode there is nothing to push to ADP at all, and the remote should not exist |
| 5-20 | `gh repo create` resolves the owner through an endpoint the server does not serve | #196 | shipped | It fails against ADP, and it fails on the first-contact path: creating the repository is step one of every walkthrough that does not start from `adp init`. Filed 2026-08-30 and, until it was pulled into this phase, in no phase — which this file's own rule forbids and `check-docs` cannot catch, because it validates the numbers that are present rather than noticing an issue that names none. The conformance suite runs it now, so the README's row is enforced rather than asserted |

**5-15 is the residual of a defect the review reported as larger than it is**, and the correction
is worth recording because the shape recurs. It read `init` and `connect` as not composing at all;
they do — `init` adds the remote `connect` then finds. What is actually wrong is subtler and
outlives the fix it would have prompted: a repository's identity is inferred from mutable local git
state, in a mode where the repository does not need a remote on this server in the first place.

**Positioning is downstream of this phase, and is deliberately not an item in it.** The review's
headline is that ADP should be marketed as disappearing underneath GitHub rather than as a
GitHub-compatible forge, and it is right about the emphasis and wrong about the trade: the `gh`
conformance gate is what makes companion mode credible rather than a competing claim on the same
budget, and OD-3 depends on it. The published site already carries three pages gated by `make site`
and has been repositioned twice on findings of this kind (see 1d). It should be repositioned a
third time — but on this phase's evidence rather than ahead of it, because a front page promising a
companion mode that 5a has not yet built is exactly the class of false published claim Phase 0 was
spent on.

### 5e — The record outlives the instance, and the verb that uses it

Exit criterion: a record can move to another ADP instance without losing what makes it evidence,
and "do this again with a better model" is one command rather than a composition the developer has
to work out.

| # | Item | Tracking | State | Why |
|---|---|---|---|---|
| 5-16 | Portability — a repository's record can leave the instance holding it | #239 | not started | See below. This is the item without which every adoption path in this phase is a trap |
| 5-17 | Run lineage — `parent_run` plus a relationship of `retry`, `continue`, `reimplement` or `supersede` | #240 | shipped | Sessions model "Codex continued Claude's unfinished work" well and "GPT-8 independently reimplemented GPT-6's bad change" not at all. They are different historical facts and only the first has a column |
| 5-18 | `adp reimplement <sha>` | #241 | not started | Recover the intent, find the base before the change, open a related run, record the new trajectory, run the same evals, compare, and offer the replacement. Every ingredient exists; the verb does not |
| 5-19 | Bake-off and reimplement launch the harness | #242 | not started | `adp bakeoff` opens the candidate set and the labelled runs and then prints instructions for wiring each harness in by hand. Powerful substrate, and the assembly is the user's |

**5-16 exists because of what hosting would otherwise commit us to, and it is the item this phase
would most regret deferring.** `PUBLIC_URL` is part of the signed record rather than a display
string — the server signs evidence with it and hands it back in clone URLs, which
`docs/self-hosting.md` states as a property of the design and warns operators to decide before the
first change lands. Every adoption story in this phase ends with a developer's record living on an
instance chosen when they were evaluating alone. If that record cannot move when their company
adopts, then the funnel that motivates the whole phase breaks precisely at the point it is supposed
to pay off, and it breaks for a reason we designed in.

So portability is not an export feature. The question it has to answer is what an evidence bundle
means after the URL it was signed under stops resolving, and the honest answers are a small set:
re-sign under the new instance and record the migration as an operation; keep the original
signatures and carry the old key's public half as part of the exported record; or accept that
history verifies only against an archived key. Deciding that is most of the work, and it is
cheapest to decide now, while the number of records that would have to migrate is small enough to
migrate by hand.

### The open decisions this phase creates

| Decision | Why it cannot be deferred past 5a |
|---|---|
| ~~**Proposal numbering in mirror mode.**~~ **Answered in #224: adopt the upstream number.** `gh pr view 482` means one thing on both planes, and a repository with inbound ingest enabled refuses natively created proposals — on both REST and GraphQL, because `gh pr create` uses the second | `proposals` is unique on `(repo_id, number)`. The cost of the answer is that a repository cannot mix native and ingested proposals, and a proposal that predates the mirror keeps its number: ingest refuses to overwrite it rather than destroying a record to make room for a mirror of one |
| ~~**Whether an ingested pull request may be landed through ADP.**~~ **Answered in #234: evaluable, not landable.** `land` refuses a proposal carrying an upstream number, before evaluating the policy, and the refusal names GitHub as the merge authority and the `ADP / policy` check run as how the verdict acts | Two writers against one branch. The cost of the answer is that `adp land` is unavailable on an ingesting repository — which is the point: requiring the check in branch protection is the same enforcement with none of the migration |
| **What a free or evaluating instance may claim about durability.** M4-8 and M4-10 are deferred on budget, and `docs/self-hosting.md` correctly claims nothing about backup or PITR until a restore drill has been executed | Companion mode changes the stakes rather than the engineering: where GitHub stays the merge authority, losing an ADP instance degrades the record and loses no code. That is a real argument and it is worth writing down as a position with a tripwire, not left as a consolation |

---

## Phase 2 — The serial-base-case forward work

**Why now:** the 2026-08-17 reweighting named three consequences and none of them was ever
tracked. They are the differentiator the reweighting implies. Both remaining items have a release
in Phase 1 to land in.

| # | Item | Tracking | State |
|---|---|---|---|
| 2-4 | Provenance-priced approval — the approver differs by model, harness or session, not merely by identity | #176 | not started, and unblocked: 1-1 (#141) shipped, so a token carries `harness`, `model` and `session_id` over the wire and a signed change names them |

Items 2-1, 2-2 and 2-3 — author-independent approval (#121), compensating-revert undo (#159) and the
cross-harness demo (#160) — shipped and are gone from this table. Their numbers are not reused, for
the reason given under 1a. 2-2 and 2-3 landed inside release 1c, which is where what they settled is
written down.

**2-4 is the last of the three consequences the 2026-08-17 reweighting named**, and it is now the
only one outstanding.

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

**What changed on 2026-09-02:** 3-5 acquired a second consumer, and it is a more urgent one than
the first. The item was justified as the input to 3-6 — the numbers that decide a retention window
and a tiering boundary — and 3-6 is blocked on a decision about object storage that is itself
deferred on budget, so nothing was waiting on 3-5 with any urgency. Phase 5 changes that. Every
adoption path it opens ends with someone else's trajectories on an instance, and **bytes per unit
is what says whether that is affordable**: what a repository costs per month decides whether a free
or evaluating tier is a rounding error or an open-ended commitment, and no amount of design
discussion substitutes for the measurement. It is also the cheapest item in this file — no model,
no tokens, deterministic, and CI-runnable — so the ordering argument is entirely one-sided. It
moves ahead of 3-3, and it should be run before any commitment is made to hosting anything for
anyone else.

The reason it was not already urgent is worth keeping, because it is the same reason 3-1 and 3-2
stopped being cheap fixes taken early: an item's priority is set by what is about to consume it,
and this file has now twice had to re-rank storage work when something new started writing.

| # | Item | Tracking | State | Why |
|---|---|---|---|---|
| 3-3 | Make the SBOM deterministic so identical dependency sets dedup | #194 | not started | `randomUUID()` and a fresh timestamp per land make ~8 KB of every ~12 KB landed change un-dedupable and ~100% redundant. Pure win; needs no object store |
| 3-5 | Bench arm 4 — `storage-growth` | #195 | not started, and **pulled forward** — see below | Deterministic, no model, no tokens, CI-runnable like arm 1: bytes per unit on a real Postgres, realised vs batched compression, dedup yield, ingest cliff, peak RSS on `/verify`. It is also the only thing that prices a user, which is why it no longer sits behind the rest of this phase |
| 3-6 | Retention and tiering as org policy | — | blocked on 3-5; 1-16 shipped the interval | The intended shape — hot/extended tiers with promote-on-reference, attestations committing to digests never payloads, "verified, payload not retained" as an honest third verification state — is settled; the numbers that justify it come from 3-5. 1-19 (#199) built the commitment half already: an event whose payload is stored as structure carries `payload_digest`, covered by the chain. 1-16 covers the interval. The object-store half also waits on decision 2 |

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
| **Hosted preview** — M4-8 (managed Postgres + object store), M4-10 (backup/PITR + executed drill) | Blocked on decision 2 (budget) and decision 3 (drill timing). Engineering is not the constraint. Split out of M4 so a purchase order stops holding a milestone open. **Phase 5 narrows what this row is for**: M4-8 and M4-10 are what hosting has to have to be *charged for*, not what it has to have to be *tried*, and companion mode lowers the stakes of losing an instance because GitHub stays the merge authority. What it does not lower is 5-16 — a record that cannot leave the instance holding it makes any hosted tier a trap, whatever it costs to run |
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
