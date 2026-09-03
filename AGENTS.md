# AGENTS.md — ADP

The agent-native forge: a self-hosted, GitHub-compatible forge for AI coding agents. It
speaks GitHub's protocols (git wire, REST at `/api/v3`, GraphQL at `/api/graphql`) over a
domain model where every change is a signed transaction binding
**intent → diff → evidence → provenance**. The native plane at
`/api/adp` (and over MCP) exposes what GitHub has no analogue for: the operation log,
undo, evidence bundles, workspaces. TypeScript · Fastify · PostgreSQL · the real `git`
binary for all plumbing.

## Where the plans live

- **`PLAN.md`** — the single executable backlog, and the authority on scope: every open
  work item, phased, each naming its tracking issue, plus the open decisions and what is
  deferred with the reason. If work is not in this file it is not planned. A PR that
  finishes an item updates it in the same PR.
- **`CHANGELOG.md`** — what actually shipped, per released version. A capability that
  reaches `main` gets an entry; the version it ships under is the one
  `server/src/api-version.ts` serves.
- **`README.md`** — orientation for someone who has never seen the project.

**A fact lives in exactly one of these, never two.** The 2026-08-22 audit found sixteen
contradictions across the doc set, every one of them a fact with an owner elsewhere that
had been copied into prose and then left behind when the owner moved. `scripts/check-docs.sh`
fails the build on the mechanical cases, and `scripts/dev/check-release.sh` on the version ones.

The status ledger that used to sit in `ROADMAP.md` is gone rather than moved: milestone
tables describing this project's own history are archaeology, and every fact worth keeping
already had an owner — the contract version in `api-version.ts`, what shipped in
`CHANGELOG.md`, what is left in `PLAN.md`.

## Process

**Nothing is committed to `main`.** Every change reaches it through a pull request —
including one-line and docs-only changes, and including changes made by an agent.
Commit messages and PR bodies carry no AI attribution, and name no model or vendor.

That last rule has a failure mode an agent cannot avoid by obeying it. Several harnesses
append their own attribution footer to a pull request body **server-side, after
submission** — so a body that left the agent clean arrives on GitHub carrying a
*Generated with …* line the agent never wrote and does not see unless it looks. PR #162
opened that way, by an agent that had deliberately omitted one. Writing no attribution is
therefore not sufficient: **an agent opening a pull request here re-reads the body as
GitHub stored it and edits the footer out.** Same for the commit message if a harness
appends trailers to that.

The scope is the record that travels with the change — the commit message and the pull
request body. Issue comments, review comments and PR comments are a different surface and
keep whatever their tooling adds; who wrote a comment is useful context for the person
reading it, and it is not part of the permanent record of the change.

### Branches

Branch off `main`, and name the branch for the kind of change it carries. There are
three prefixes and no others:

| Prefix | For |
|---|---|
| `feat/` | new capability — a route, a plane, a milestone item |
| `fix/` | something is wrong and this makes it right: bugs, hardening, CI and tooling repair, and cutting a release |
| `docs/` | prose, the published site, the plan and status files |

Three and no others — a release included. `release/0.3.0-contract` (#115) predates this
rule; the next one is `fix/0.6.0-release`, because a release corrects the versions the
tree claims. A fourth prefix would cost the rule the thing that makes it stick.

Lowercase, hyphen-separated, and describing the change rather than the actor. Where an
item has a tracking issue, leading with its number is the established shape:

```
feat/org-storage-quota
fix/92-gate-job-lease
docs/readme-quickstart
```

**If your session started you on a branch named after your harness — `claude/…`,
`codex/…`, `cursor/…`, `agent/…` — that name is the tool's default, not a choice, and it
is not one of the three.** Rename it before you push:

```bash
git branch -m docs/what-this-actually-does
```

A branch already pushed under the wrong name gets a correctly-named replacement, and the
original is deleted rather than left to accumulate. Which prefix applies is decided by
the change, not by which tool made it: an agent fixing a bug is on `fix/`, exactly as a
human would be.

`scripts/dev/check-branch.sh` enforces this — in `make check`, and as a CI job that
fails the pull request. It is a check rather than a note for the reason above: by the
time anyone reads this file, the branch already exists.

### A worktree per task

Work in a worktree rather than switching a shared checkout's branch. It is what lets one
session run `make check` while another is mid-edit, and it is the reason `.gitignore`
carries a note about dependency trees rather than only a rule.

```bash
make worktree BRANCH=fix/92-gate-job-lease   # branch, worktree, and every dependency tree
cd .worktrees/92-gate-job-lease
make up && make check
make worktree-remove DIR=.worktrees/92-gate-job-lease   # from somewhere else
```

`scripts/dev/worktree.sh` does the three things a bare `git worktree add` leaves you to
discover. It checks the branch name against `check-branch.sh` — the same script that
fails the pull request — so a name that will be rejected is rejected while renaming it is
still one flag rather than a force-push and an abandoned branch. It branches off the
*fetched* `origin/main`, because a worktree cut from a stale local `main` fails quietly:
everything works, the pull request is just built on last week's tree and carries a diff
nobody asked for. And it installs dependencies, because a fresh worktree shares the
repository and shares nothing else.

**Install the dependency trees; do not link them.** Sharing one tree between worktrees by
symlink is the obvious shortcut and it is a trap twice over: the link silently serves the
other checkout's dependencies whenever the two lockfiles disagree, and two
machine-specific absolute symlinks reached `main` that way in #128 — which is why
`.gitignore` matches `node_modules` with no trailing slash, so a *symlink* by that name
cannot walk past it. `npm ci` across every tree is about eight seconds against a warm
npm cache. That is not the cost worth optimising.

`make worktree-remove` exists because the safe spelling has to be the easy one, the same
lesson `gh pr merge --delete-branch` taught in the section below. Plain
`git worktree remove` refuses while `node_modules` is there; the next thing anyone reaches
for is `--force`, which also discards uncommitted changes without mentioning it. So the
script checks first, clears the dependency trees, and then removes the worktree with plain
`git`.

**Uncommitted changes to tracked files are the only thing it refuses over**, because they
are the only thing removing a worktree destroys: the branch is never deleted, so its
commits survive whether or not a remote has them. Refusing over unpushed commits — which
this did at first — is a false alarm on the most common call of all, cleaning up after a
landed pull request, and a safe spelling that cries wolf is how people end up back on
`--force`. What is left of that check is a report: the branch's own state, and whether it
holds commits no remote does.

It also tears down the worktree's test stack before removing it. `make up` names its
compose project after the checkout and records it in that checkout's `.env.test`, so
deleting the worktree deletes the only record of the project — `down.sh` says as much in
its own comments, and `make worktree-remove` was the thing creating the orphans it warns
about. Five leaked containers and five leaked networks accumulated over one session before
anyone ran `verify-clean.sh`.

`ADP_WORKTREE_ROOT` moves the default location — an agent harness that keeps its state
under a directory of its own points it there, and `DIR=` overrides per invocation.

**A worktree that cannot run the suite is the failure this is built around.** A missing
dependency tree used to surface forty minutes into `make check`, in the seventh target, as
`sh: 1: vitest: not found` — naming neither the cause nor the remedy, after everything
expensive had already run. `make test-all` now asks `make check-deps` before the first
test, which also catches the case a fresh install cannot: a tree installed before a
dependency change on this branch, which CI would never test against.

### Landing a stack

**Do not delete a branch another open pull request is based on.** GitHub does not orphan
the dependent — it *closes* it, and a closed pull request whose base branch is gone can be
neither reopened nor retargeted. The commits survive; the review thread, the number, and
every link pointing at it do not. This happened twice on 2026-08-29, to #172 and #180, and
the second time the branch was deleted by `gh pr merge --delete-branch` — which makes the
destructive step the default spelling of the safe one.

So land pull requests with the script rather than by hand:

```bash
make land PR=181          # or: bash scripts/dev/land.sh 181
```

`scripts/dev/land.sh` refuses a pull request whose checks are not green or that GitHub
reports unmergeable, asks whether anything is stacked on the branch *before* merging, and
deletes the branch only when nothing is. When something is, it merges, keeps the branch,
and prints the recipe for the child: rebase onto the new base — the squash makes git drop
the merged commit as already applied — push with `--force-with-lease`, retarget with
`gh pr edit`, and land it the same way.

A stack is worth keeping when the parts are separately reviewable, and it is worth
insisting on when one part is urgent: #179 repaired a live rendering fault on the published
site and should not have waited behind a copy edit. The cost of a stack is one rebase, and
that is cheaper than either enlarging a focused pull request or delaying a fix.

**Do not regenerate this file.** Most of what follows was learned by getting it wrong,
and a codebase scan cannot see any of it — so a command that rebuilds project
instructions by scanning the repository (`/init` and its equivalents) will silently
replace hard-won knowledge with a description of the file tree. Edit it by hand;
`make check` fails if a path named here stops existing — and, since 2026-08-22, if a link
in any tracked document dangles or a `#NNN` in `PLAN.md` disagrees with its
real state on GitHub.

This file is the instruction set for **any** coding agent working in this repository, and
for humans. It is `AGENTS.md` because that is the name the tooling around it has
converged on; `CLAUDE.md` is a symlink to it so that agents looking for the older name
find the same text rather than a second, drifting copy.

## Layout

| Path | What lives there |
|---|---|
| `server/src/` | the Fastify server, with unit tests colocated beside the code |
| `server/test/` | integration and e2e tiers (vitest) |
| `server/acceptance/` | the §2.1 walkthrough, driven by Playwright |
| `server/conformance/` | the real-`gh` gate |
| `server/drizzle/`, `server/web/` | migrations; the supervision UI |
| `cli/` | the `adp` CLI (no database needed to test). Thin REST wrappers, plus `connect`/`disconnect` (#154), which write a harness's own configuration into the repo and then prove it with a real session |
| `adapters/` | scanner-as-gate adapters (osv-scanner, wizcli) |
| `runner/` | the gate runner: polls `/api/adp/gate-jobs/claim`, executes in an isolated container (network-deny, no host mounts, no ambient secrets, resource caps), reports via `/complete`. A pure HTTP client like `cli/` — no `server/` import, no DB or signing-key credential |
| `recorder/` | `adp-recorder`: the out-of-band trajectory producer (#149). Durable spool, batching shipper, idempotent replay, and one reader per harness under `src/readers/` (#150) — translation lives here so that `harness` stays a string the server never branches on. A pure HTTP client on `runner/`'s terms — no `server/` import, no DB or signing-key credential, and only `repo:write`, so it runs as the developer rather than as infrastructure |
| `bench/` | benchmark arms, runs, and the generated report |
| `dc-runtime/` | the published site's client runtime. Builds `docs/html/support.js` and the React bundles beside it — all committed, because the site itself has no build step. `dc-runtime/test/` drives every published page in a real browser (`make site`) |
| `spec/` | the published contract: `spec/openapi.yaml`, `spec/schemas/`, `spec/graphql/github.graphql` |
| `scripts/dev/` | what the Makefile actually runs — `up`, `down`, `doctor`, `verify-clean`, `deps` and `worktree` (§A worktree per task), and `local` (a persistent local instance with a certificate `gh` will accept, #158) |
| `deploy/`, `infra/` | production compose stack; Terraform for the GCP dev box |
| `helm/adp/` | the self-host chart (M4-12). `make helm` lints it, renders every branch, and asserts the combinations it must *refuse* still refuse — `scripts/dev/helm-check.sh` |

Node 22 (`.nvmrc`).

## Commands

The Makefile is the entry point — `make help` lists everything. The loop is:

```bash
make doctor     # preflight: toolchain, docker, ports, stale containers
make up         # throwaway Postgres on a random port, writes .env.test
make check      # the gate: everything CI runs, plus the doc checks
make down       # tear down AND assert nothing leaked
```

**`make check` is the gate in every repo in this line of work** — reach for it first and
don't go hunting for the per-repo incantation. Here it is `make test-all` (build, full
suite, web, cli, adapters, conformance, acceptance) preceded by `make check-docs`.

`make test-unit` runs the unit + integration tiers with no database. `make test` is the
full suite with e2e enforced. `make down-all` and `bash scripts/dev/verify-clean.sh --fix`
are the recovery paths when a previous run left something behind.

`make deps` installs every dependency tree and `make check-deps` asserts they are the
ones their lockfiles describe; `make worktree` does both for a new worktree in one step —
see §A worktree per task.

Per-tool configuration lives under that tool's own directory and is not the contract —
this file is. `.claude/settings.json` is the one such file checked in, holding a shared
permission allowlist (the Makefile targets above, plus read-only `gh`); everything else
still prompts. Personal overrides belong in `.claude/settings.local.json`, which is
ignored. Another agent's equivalent config is welcome on the same terms: scoped to its
own directory, ignored by default, and never the place a project rule is written down.

## Invariants — don't "fix" these without reading why

- **A skipped test must never look like a passing one.** The e2e tier skips itself when
  `DATABASE_URL` is absent so a laptop without Postgres can still run `npm test`; that
  makes a skip and a pass indistinguishable at the exit code. CI sets `ADP_REQUIRE_DB=1`
  and `ADP_REQUIRE_NETWORK=1` to turn those skips into hard failures
  (`server/test/require-db.ts`, `require-network.ts`). Before this existed, `npm test`
  exited green while silently skipping 42% of the suite. Any new tier that can skip
  itself needs the same guard, set unconditionally in CI.
- **Test-runner ownership is by directory.** vitest owns `src/` and `test/`; Playwright
  owns `acceptance/`, which `server/vitest.config.ts` excludes. Don't put a `*.spec.ts`
  that needs a browser anywhere vitest can collect it.
- **`spec/openapi.yaml` is a published contract, not documentation.**
  `server/src/spec-coverage.test.ts` fails when the server serves a route the spec does
  not describe — it *had* drifted silently before. adp-replay generates its client from
  this spec, so changing a response shape breaks a downstream consumer.
- **`gh pr checks` is green, and the acceptance suite pins what an agent sees.** This was
  the last §2.1 gap: `statusCheckRollup.state` was real but `contexts` was a deliberately
  empty connection, so `gh` reported "no checks reported" and exited non-zero on a green
  rollup. PR #53 closed it (2026-08-03) — each gate result projects to a `StatusContext`.
  `server/acceptance/run.sh` now asserts the rollup is SUCCESS *and* that `gh pr checks`
  names the gate, reports it passing, and links the DSSE evidence bundle behind the
  verdict. The design intent survives inverted: the assertion is what an agent actually
  sees, so regressing the projection breaks the test on purpose.
- **`docs/html/` is deployed straight from the tree, so a generated file there is a
  published file.** `pages.yml` uploads the directory wholesale on every push to `main`
  that touches it — there is no build step between the repository and the site, and that
  is deliberate (#138): the front door stays editable with a text editor. The cost is that
  `docs/html/support.js` and `docs/html/vendor/*` are build *outputs* that ship as
  *inputs*. `make dc-runtime` rebuilds them and asserts they are unchanged, and CI's
  `site-runtime` job does the same — never hand-edit them, and never commit a `dc-runtime/src`
  change without the regenerated artifacts. Until #163 the source did not exist here at
  all: the runtime was generated from a `dc-runtime/` that was in no repository anyone
  working here could reach, which made a 69 KB dependency of the front page unfixable.
  `dc-runtime/README.md` records how it was recovered and how that recovery was verified.

  **The share cards are the exception, and the exception is reasoned.** `docs/html/og.png`,
  `why/og.png`, `sdlc/og.png` and `apple-touch-icon.png` are generated the same way — by
  `make og`, from `dc-runtime/og/card.html` — but they are *not* byte-checked, because a
  screenshot is not reproducible the way an esbuild bundle is: Chromium's glyph
  rasterisation moves with the browser version and the faces come from Google Fonts at
  render time. A byte guard would fail on a Playwright bump rather than on a change anyone
  made, and a guard that cries wolf gets deleted. `make site` asserts what does go wrong
  instead — they exist, they are PNGs at exactly 1200×630, they are small enough to fetch,
  and every share asset a page names resolves. Don't add `make og` to `make check` on the
  strength of the paragraph above this one.

- **`docs/html/site.css` is the site's only design system, and neither page may grow a
  second one.** The palette, a seven-step type ramp and an 8-base spacing scale live there;
  no page declares a colour or a static inline `style=` of its own, and the essay's
  simulations reach their colours through `var(--sim-*)` rather than hex literals in
  JavaScript — 91 of those were the reason a restyle used to mean editing a logic class.
  Two kinds of inline style survive by design, both in `/why/`: a width or an opacity a
  simulation computes per frame is *state*, not styling, and each is required to carry a
  `{{ hole }}`. `make site` asserts all of this, along with #163's other exit criteria —
  five widths with no horizontal scroll on the body, tables readable at 375px, a focus ring
  on every interactive element. These were checked by looking until 2026-08-29, which is
  how the site came to have two palettes and thirteen unrelated spacing values.

- **Nothing on the published site may load from a third party except Google Fonts.** The
  runtime used to pull React, ReactDOM and `@babel/standalone` from `unpkg.com` at read
  time; because it hides the raw template before loading them, an unreachable unpkg served
  a blank page rather than a degraded one. The React bundles are vendored under
  `docs/html/vendor/` now, from the pinned dependencies and byte-identical to what the CDN
  served. Adding a script, style or font from anywhere else re-opens that failure mode.

- **How a change arrived must not determine the quality of its provenance.** A commit
  pushed by a connected harness records the same `harness`, `model` and `session_id`
  whether it came through `git push` or through `POST /changes` — the two blocks differ
  only in `via`, and `server/test/e2e-push-provenance.test.ts` asserts that by comparing
  them rather than by checking a shape. It is written down here because the failure was
  silent for a whole release: `AuthenticatedIdentity` had carried all three since 1-1, the
  REST route wrote all three, and the push path — the one 1b exists to make the *default*,
  and therefore the only one an agent actually takes — wrote none of them. The provenance
  block was present, signed, and merely thinner, which is indistinguishable from a human
  pushing without a harness. Nothing could have caught it except a test that knows the two
  routes are supposed to agree.

- **The operation log is written in the same database transaction as the change.** Don't
  add a write path that records a change without it.
- **The gate-job queue is bespoke, and that is a decision — not an omission.** The plan
  named `pg-boss`; the queue and sweeper that shipped are our own, built directly on
  `gate_jobs` with `FOR UPDATE SKIP LOCKED`, claim leases, a reaper, and advisory tick
  locks (#92–#96). Keeping it was the audit's P1-7 call: it is small, the reliability
  fixes were cheap, and it enqueues transactionally alongside the change record. Don't
  "restore" `pg-boss` on the strength of an old doc. Revisit only if a fleet-scale runner
  pool needs `LISTEN/NOTIFY` and real retry backoff — and revisit with the poll-load
  numbers the queue telemetry now produces, not on principle.

## Gotchas

- **There are three compose files and they are not interchangeable.**
  `deploy/docker-compose.yml` is the production stack, `docker-compose.test.yml` is the
  ephemeral one `make up` uses, and `docker-compose.local.yml` (#158) is the middle case:
  Postgres on a *named volume* and a fixed port, for an instance you come back to. Its
  project name is `adp-local`, deliberately outside `verify-clean.sh`'s `adp-test-*` sweep —
  it is not leaked state, it is state someone asked to keep. `make local-destroy` is the
  only thing that deletes it.
- **Never use `deploy/docker-compose.yml` for local dev or test.** It is the production
  stack: `restart: unless-stopped` containers resurrect themselves, bind fixed ports, and
  collide across worktrees on the shared project name `deploy`. `deploy-server-1` in
  particular serves a separately-built stale image on port 3000, which makes routes that
  provably exist return 404. `make up` uses `deploy/docker-compose.test.yml` instead —
  Postgres only, tmpfs, no restart policy, ephemeral port, per-run project name.
- **Test-harness ports come from `scripts/dev/ports.sh`, below the kernel's ephemeral
  floor.** `conformance/run.sh` and `acceptance/run.sh` used to pick random ports in
  ranges that overlapped `/proc/sys/net/ipv4/ip_local_port_range` — the TLS proxy's
  range sat inside it completely — so `listen()` periodically lost a race to an
  unrelated outbound socket. That cost three full runs before it was chased: the proxy
  died at startup and the run failed minutes later as an unexplained `connection
  refused`. Pick with `adp_pick_port`, and wait for a backgrounded process with
  `adp_wait_for_log_line` (its own readiness line) rather than a port probe, which a
  squatter also satisfies.
- **`tools/win/Run-CleanTest.ps1` is a local validation tool, not a gate.** It answers
  "does this work from nothing?" on demand, needs a Windows host, and takes ~16 minutes.
  Do not wire it into CI; `clean-room.yml` already catches most of that class per push.
- Agent tool directories are ignored by contents, not as directories: `.claude/*` with
  `.claude/settings.json` re-included, so worktrees and scratch stay out of the tree while
  the shared allowlist is versioned. Ignoring the directory itself (`.claude/`) would make
  that negation silently do nothing. Add any new agent's directory the same way.
- **The repository's GitHub topics are deliberate, and they are not the words we use
  internally.** `ai-agents`, `provenance`, `supply-chain-security`, `sdlc`, `git`, `slsa`,
  `in-toto`, `devsecops`, `mcp`, `self-hosted`. They were empty until 2026-09-03, which is a
  free discovery surface left unset — topics are how GitHub is browsed and filtered, and they
  feed its search. They are chosen for how somebody would look for this rather than how the
  README describes it: nobody searches for "agent-native forge", and the people who would
  benefit are searching for the problem. There is no API that records *why* a topic is set, so
  it is recorded here.

- Building the test environment found 19 bugs, 12 pre-existing, and the most valuable
  ones were invisible in containers: a dangling Docker Desktop symlink, a missing compose
  plugin, `sudo` rewriting `$USER`. A container is a clean machine; a laptop is a dirty
  one, and the dirt is the point.
