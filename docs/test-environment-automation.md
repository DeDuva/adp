# Test environment automation

**Status:** Phase 0 landed; Phases 1–4 proposed.

The goal, stated as a test: a tester with a **brand new Windows machine** installs WSL, clones
this repo, runs one command, watches the full manual test suite execute, and runs one more
command that returns the machine to exactly the state it was in beforehand. Nothing left
behind — no containers, no volumes, no daemons, no stray processes, no drifted config.

This document says how much of that can be automated (~95%), what the irreducible residue is,
and the order to build it in.

---

## 1. Why this is needed — the specific failure modes

These are not hypothetical. Each was found in the repo or on the developer machine on
2026-08-01.

| # | Finding | Consequence |
|---|---|---|
| 1 | All nine e2e suites were `describe.skipIf(!process.env.DATABASE_URL)` | `npm test` exited **green** with the majority of real coverage silently disabled. A pass was indistinguishable from a skip. **Fixed in Phase 0.** |
| 2 | `docker` unreachable in the WSL distro (Docker Desktop integration off or daemon down) | The most common hard stop, and invisible until a test fails for an unrelated-looking reason. |
| 3 | `deploy/docker-compose.yml` uses `restart: unless-stopped`, named volumes, and fixed ports 80/443 | Containers resurrect themselves after a Docker restart. This is the stale `deploy-server-1`-on-port-3000 trap: a route that provably exists in the checked-out source 404s, because a months-old image is answering instead of `npm run dev`. |
| 4 | Compose project name defaults to the directory name, `deploy` | Every checkout and every git worktree collides on one set of containers and volumes. |
| 5 | Three different defaults for one connection string: `.env.example` had `adp:change-me@postgres`, `conformance/run.sh` and CI had `adp:adp@localhost` | Following `server/README.md` literally produced a DSN that cannot resolve outside compose. |
| 6 | The developer machine's running stack publishes `5432`; the committed compose file publishes no ports at all | Local config had drifted from the repo. Unreproducible by construction. |
| 7 | No `.nvmrc`. CI pins Node 22; the dev machine runs Node 24 | Silent version skew between local and CI. **Fixed in Phase 0.** |
| 8 | `server/web` is built by a separate optional step, and `main.ts` skips serving `/ui/*` silently if it is absent | Web UI test steps can "pass" against a UI that was never built. |
| 9 | No teardown script, no preflight check, and no written manual test plan | Teardown is tribal knowledge, so it is performed inconsistently, so state leaks between runs. |

Findings 1, 3 and 4 are the direct mechanical causes of partial runs and broken Docker
configs. Finding 9 is why they never got fixed the same way twice.

---

## 2. How much can be automated

**~95%.**

Fully automatable: WSL distro creation and destruction, toolchain installation, Docker engine
installation and startup, dependency bring-up, repo clone, environment generation, migrations,
every test tier including the `gh` conformance gate, web UI build and drive, teardown, and —
critically — *verification that teardown was complete*.

The irreducible residue is three things:

1. **First-ever `wsl --install` on a virgin Windows machine.** Requires admin elevation and
   usually a reboot. One-time, about five minutes.
2. **Docker Desktop's WSL-integration toggle** is a GUI checkbox with no supported CLI.
   *This is avoidable* — see §3.
3. **Aesthetic judgment on the web UI.** Automatable down to "assert intent, evidence bundle,
   provenance and op log are present, and save screenshots." Whether it *looks* right stays
   human, but that becomes reviewing six PNGs rather than driving a browser.

---

## 3. Architecture: two isolation layers

The failure mode to design against is building one large clean-room script that is too slow for
daily use, so nobody runs it, so it rots within a month. The answer is two layers where the fast
one is literally a subroutine of the slow one, and CI exercises both.

### Layer 1 — ephemeral dependency stack (seconds; every test run)

A dedicated `deploy/docker-compose.test.yml`, separate from the production-shaped
`docker-compose.yml`:

- Postgres only — no server, no Caddy. The server under test runs from source, never from an image.
- `tmpfs` data directory; **no named volumes**.
- **No restart policy.** Nothing may outlive the run that created it.
- **Ephemeral host port** — publish `5432` with no fixed host side, then discover the real port
  with `docker compose port`. Removes the entire class of "something else is on 5432."
- `COMPOSE_PROJECT_NAME=adp-test-<short-sha>-<pid>` so worktrees and parallel runs never collide.

The key insight behind finding 3: the bug was never the production compose file. The bug was that
dev and test *reuse* the production compose file. `deploy/docker-compose.yml` should stay exactly
as it is — it describes a deployment, and deployments are supposed to restart themselves.

### Layer 2 — disposable WSL distro (minutes; on demand and nightly)

A PowerShell entrypoint that `wsl --import`s a throwaway distro from a cached rootfs tarball,
runs bootstrap → Layer 1 → the full suite → teardown inside it, then `wsl --unregister`s it.

The distro *is* the teardown guarantee. Nothing leaks because the filesystem ceases to exist.
This is the only honest way to test the "brand new machine, clone the repo, follow the README"
path, and it is what actually satisfies "return the machine to its prior state."

### Docker Desktop is not a dependency

Layer 2 installs `docker.io` **inside the throwaway distro**. Consequences: finding 2 becomes
impossible (the daemon is started by the same script that needs it), and finding 3 becomes
impossible (the daemon dies with the distro, so no restart policy can outlive a run).

This is a real change to the daily workflow and Docker Desktop keeps genuine advantages for
interactive debugging. The recommendation is therefore: **keep Docker Desktop for ad-hoc poking,
route all *testing* through the disposable path.** Managing a long-lived daemon that holds
restart-policied containers and drifted config across reboots is a permanent tax; a distro-local
daemon removes the category rather than managing it.

---

## 4. Deliverables

```
Makefile                          # doctor | up | test | test-all | down | nuke — one entrypoint, CI uses it too
scripts/dev/lib.sh                # shared constants, logging, the canonical local DSN      [Phase 0]
scripts/dev/doctor.sh             # versions, ports, orphans, docker reachability           [Phase 0]
scripts/dev/verify-clean.sh       # asserts zero adp-* containers/volumes/networks/ports    [Phase 0]
server/test/require-db.ts         # turns a silent e2e skip into a hard failure             [Phase 0]
.nvmrc                            # 22                                                      [Phase 0]
scripts/dev/up.sh                 # ephemeral compose, wait healthy, emit .env.test         [Phase 1]
scripts/dev/down.sh               # compose down -v --remove-orphans + kill stray PIDs      [Phase 1]
scripts/dev/env.sh                # generate .env.test: random SIGNING_KEY, discovered port [Phase 1]
deploy/docker-compose.test.yml    # Postgres only, tmpfs, ephemeral port, no restart policy [Phase 1]
scripts/dev/bootstrap.sh          # bare Ubuntu -> provisioned (apt, docker.io, Node 22)    [Phase 2]
.github/workflows/clean-room.yml  # runs bootstrap.sh on a bare runner so it cannot rot     [Phase 2]
docs/manual-test-plan.md          # written first, then progressively emptied into tests    [Phase 3]
server/test/acceptance/           # the §2.1 definition-of-done walkthrough, executable     [Phase 3]
tools/win/Run-CleanTest.ps1       # import distro -> bootstrap -> test -> unregister        [Phase 4]
```

### Two invariants that make the difference

**Every script registers a `trap` cleanup.** `server/conformance/run.sh` already does this
correctly — its `cleanup()`/`trap cleanup EXIT` pair is the pattern to copy. A script that
cleans up only on the success path is how leaked state accumulates.

**`verify-clean.sh` runs at the start of a run as well as at the end.** Checking only at the end
tells you that you made a mess. Checking at the start refuses to produce a result that inherited
someone else's mess — which is the actual defect being fixed, since a run polluted by leftovers
reports a *wrong* answer rather than an obviously broken one.

---

## 5. Phasing

### Phase 0 — preflight and honesty *(done)*

Half a day. Worth doing even if everything after it is dropped.

- `ADP_REQUIRE_DB=1` converts the nine silent e2e skips into a hard collection failure; set in CI.
- `scripts/dev/doctor.sh` — preflight the environment before anything runs.
- `scripts/dev/verify-clean.sh` — detect leaked state, at start and end.
- `.nvmrc` pinning Node 22, matching CI.
- One canonical local DSN in `scripts/dev/lib.sh`, referenced by conformance and the READMEs.

Closes findings 1, 5 and 7, and makes 2, 3 and 6 *visible* instead of mysterious.

### Phase 1 — ephemeral dependencies

1–2 days. `docker-compose.test.yml` + `Makefile` + `up`/`down`/`env`. Namespaced, ephemeral,
no restart policies, discovered ports.

Closes findings 3, 4 and 6.

### Phase 2 — bootstrap from bare metal

2–3 days. `bootstrap.sh` taking a bare Ubuntu to fully provisioned, with in-distro `docker.io`,
plus `clean-room.yml` running it on a clean CI runner on every push.

The CI job is not optional. A bootstrap script that CI does not execute is a work of fiction
within a month — it is the only way to know the "brand new machine" path still works.

Closes finding 2.

### Phase 3 — the manual suite, executable

2–3 days. Write `docs/manual-test-plan.md` first — it does not exist today, which is why
finding 9 exists — then automate it step by step.

The spine is the §2.1 definition of done in `docs/pragmatic_mvp.md`: clone → `gh issue view` →
edit → push → `gh pr create` → `gh pr checks` green → `gh pr view` shows a typed review →
`gh pr merge` → a human opens the web UI and sees intent, signed evidence bundle, provenance and
op log → clicks undo.

`server/conformance/run.sh` already covers roughly 60% of that against a real, pinned, unmodified
`gh` binary. The gaps are: `gh pr checks` going green, the web UI assertions, and undo. Playwright
with pinned browsers, headless, screenshots written to an artifacts directory.

Closes finding 8 — the UI build stops being optional because a test depends on it.

### Phase 4 — the Windows entrypoint

1 day, because by this point it only orchestrates Phase 2's script. `tools/win/Run-CleanTest.ps1`.

---

## 6. Usage (as it exists today, after Phase 0)

```bash
bash scripts/dev/doctor.sh          # preflight: is this machine able to run the suite?
bash scripts/dev/verify-clean.sh    # is there leaked state from a previous run?
```

Run the full suite with e2e coverage actually enforced:

```bash
ADP_REQUIRE_DB=1 DATABASE_URL=postgres://adp:adp@localhost:5432/adp npm test --prefix server
```

Without `ADP_REQUIRE_DB`, a missing `DATABASE_URL` still skips the e2e tier — that keeps
`npm test` usable on a machine with no database, which was the original and legitimate reason for
the skip. The change is that any context which *intends* full coverage now says so explicitly,
and gets a hard failure instead of a green partial run.
