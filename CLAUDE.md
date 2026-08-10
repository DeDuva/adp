# CLAUDE.md — ADP

A version control and CI/CD server that speaks GitHub's protocols (git wire, REST at
`/api/v3`, GraphQL at `/api/graphql`) over a domain model where every change is a signed
transaction binding **intent → diff → evidence → provenance**. The native plane at
`/api/adp` (and over MCP) exposes what GitHub has no analogue for: the operation log,
undo, evidence bundles, workspaces. TypeScript · Fastify · PostgreSQL · the real `git`
binary for all plumbing.

`docs/adp-prototype-implementation-plan.md` is the plan of record. `README.md` is
orientation; the readiness reviews (`docs/m2-readiness-review.md`,
`docs/m3-readiness-review.md`) record what was actually verified at each milestone.

## Process

All work lands on `main` through a pull request — including one-line and docs-only
changes. Commit messages and PR bodies carry no AI attribution.

## Layout

| Path | What lives there |
|---|---|
| `server/` | the Fastify server; `src/` code + colocated unit tests, `test/` integration + e2e, `acceptance/` Playwright, `conformance/` the real-`gh` gate, `drizzle/` migrations, `web/` the supervision UI |
| `cli/` | the `adp` CLI (no database needed to test) |
| `adapters/` | scanner-as-gate adapters (osv-scanner, wizcli) |
| `bench/` | benchmark arms, runs, and the generated report |
| `spec/` | the published contract: `openapi.yaml`, `schemas/*.json`, `graphql/github.graphql` |
| `scripts/dev/` | what the Makefile actually runs — `up`, `down`, `doctor`, `verify-clean` |
| `deploy/`, `infra/` | production compose stack; Terraform for the GCP dev box |

Node 22 (`.nvmrc`).

## Commands

The Makefile is the entry point — `make help` lists everything. The loop is:

```bash
make doctor     # preflight: toolchain, docker, ports, stale containers
make up         # throwaway Postgres on a random port, writes .env.test
make test-all   # what CI runs: build, full suite, web, cli, adapters, conformance, acceptance
make down       # tear down AND assert nothing leaked
```

`make test-unit` runs the unit + integration tiers with no database. `make test` is the
full suite with e2e enforced. `make down-all` and `bash scripts/dev/verify-clean.sh --fix`
are the recovery paths when a previous run left something behind.

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
- **The `gh pr checks` gap is asserted deliberately.** `statusCheckRollup.state` is real
  but `contexts` is an empty connection, so `gh` reports "no checks reported".
  `server/acceptance/run.sh` asserts *both* that the rollup is SUCCESS and that `gh`
  still fails this way, so implementing per-context detail breaks the test on purpose and
  forces the docs to be corrected with it.
- **The operation log is written in the same database transaction as the change.** Don't
  add a write path that records a change without it.

## Gotchas

- **Never use `deploy/docker-compose.yml` for local dev or test.** It is the production
  stack: `restart: unless-stopped` containers resurrect themselves, bind fixed ports, and
  collide across worktrees on the shared project name `deploy`. `deploy-server-1` in
  particular serves a separately-built stale image on port 3000, which makes routes that
  provably exist return 404. `make up` uses `deploy/docker-compose.test.yml` instead —
  Postgres only, tmpfs, no restart policy, ephemeral port, per-run project name.
- **`tools/win/Run-CleanTest.ps1` is a local validation tool, not a gate.** It answers
  "does this work from nothing?" on demand, needs a Windows host, and takes ~16 minutes.
  Do not wire it into CI; `clean-room.yml` already catches most of that class per push.
- `.claude/` is gitignored — agent worktrees and scratch stay out of the tree.
- Building the test environment found 19 bugs, 12 pre-existing, and the most valuable
  ones were invisible in containers: a dangling Docker Desktop symlink, a missing compose
  plugin, `sudo` rewriting `$USER`. A container is a clean machine; a laptop is a dirty
  one, and the dirt is the point.
