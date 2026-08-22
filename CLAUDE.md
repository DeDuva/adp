# CLAUDE.md — ADP

A version control and CI/CD server that speaks GitHub's protocols (git wire, REST at
`/api/v3`, GraphQL at `/api/graphql`) over a domain model where every change is a signed
transaction binding **intent → diff → evidence → provenance**. The native plane at
`/api/adp` (and over MCP) exposes what GitHub has no analogue for: the operation log,
undo, evidence bundles, workspaces. TypeScript · Fastify · PostgreSQL · the real `git`
binary for all plumbing.

## Where the plans live

- **`ROADMAP.md`** — the single status ledger: milestone states, API contract version,
  blockers, open decisions. A PR that changes milestone status updates it in the same PR.
- **`PLAN.md`** — the single executable backlog: every open work item, phased, each naming
  its tracking issue. If work is not in this file it is not planned. A PR that finishes an
  item updates it in the same PR.
- **`docs/pragmatic_mvp.md`** — the plan of record; it decides scope. (It superseded
  `docs/adp-prototype-implementation-plan.md`, the original 24-week prototype proposal,
  which is kept as history.)
- The readiness reviews (`docs/m2-readiness-review.md`, `docs/m3-readiness-review.md`)
  record what was actually verified at each milestone; `README.md` is orientation.

**Status lives in exactly one of these, never two.** The 2026-08-22 audit found sixteen
contradictions across the doc set — three critical, all in `ROADMAP.md` — every one of them
a fact with an owner elsewhere that had been copied into prose and then left behind when the
owner moved. `scripts/check-docs.sh` now fails the build on the mechanical cases.

## Process

All work lands on `main` through a pull request — including one-line and docs-only
changes. Commit messages and PR bodies carry no AI attribution.

**Do not regenerate this file with `/init`.** Most of what follows was learned by getting
it wrong, and a codebase scan cannot see any of it. Edit it by hand; `make check` fails if
a path named here stops existing — and, since 2026-08-22, if a link in any tracked document
dangles or a `#NNN` in `ROADMAP.md`/`PLAN.md` disagrees with its real state on GitHub.

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

`.claude/settings.json` is checked in and holds the shared permission allowlist — the
Makefile targets above, plus read-only `gh`. Everything else still prompts. Personal
overrides belong in `.claude/settings.local.json`, which is ignored.

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
- `.claude/` is ignored by contents (`.claude/*`) with `.claude/settings.json` re-included,
  so agent worktrees and scratch stay out of the tree while the shared allowlist is
  versioned. Ignoring the directory itself would make that negation silently do nothing.
- Building the test environment found 19 bugs, 12 pre-existing, and the most valuable
  ones were invisible in containers: a dangling Docker Desktop symlink, a missing compose
  plugin, `sudo` rewriting `$USER`. A container is a clean machine; a laptop is a dirty
  one, and the dirt is the point.
