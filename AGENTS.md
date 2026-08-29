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
| `cli/` | the `adp` CLI (no database needed to test) |
| `adapters/` | scanner-as-gate adapters (osv-scanner, wizcli) |
| `runner/` | the gate runner: polls `/api/adp/gate-jobs/claim`, executes in an isolated container (network-deny, no host mounts, no ambient secrets, resource caps), reports via `/complete`. A pure HTTP client like `cli/` — no `server/` import, no DB or signing-key credential |
| `bench/` | benchmark arms, runs, and the generated report |
| `dc-runtime/` | the published site's client runtime. Builds `docs/html/support.js` and the React bundles beside it — all committed, because the site itself has no build step. `dc-runtime/test/` drives every published page in a real browser (`make site`) |
| `spec/` | the published contract: `spec/openapi.yaml`, `spec/schemas/`, `spec/graphql/github.graphql` |
| `scripts/dev/` | what the Makefile actually runs — `up`, `down`, `doctor`, `verify-clean` |
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
- Building the test environment found 19 bugs, 12 pre-existing, and the most valuable
  ones were invisible in containers: a dangling Docker Desktop symlink, a missing compose
  plugin, `sudo` rewriting `$USER`. A container is a clean machine; a laptop is a dirty
  one, and the dirt is the point.
