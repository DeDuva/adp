# Test environment automation

**Status:** Phases 0–4 landed. The plan is complete; §7 records what is left.

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

### Found by the automation itself

Three more surfaced only once Phase 1 could put a genuinely *empty* database and a
leak-detector behind every run. All three are the fresh-machine case specifically — which is
the case this document exists to make routine.

| # | Finding | Consequence |
|---|---|---|
| 10 | Eight e2e suites each call `migrate()` in `beforeAll`, and vitest runs them in parallel | Against an empty database they race and some lose. Invisible until now because both environments that ran the e2e tier had migrations already applied — CI runs `npm run migrate` as its own step, and a developer's local Postgres was migrated days earlier. A brand-new machine has neither accident. **Fixed** by `server/test/global-setup.ts`. |
| 11 | `conformance/run.sh`'s cleanup trap killed `$SERVER_PID`, which is the `npx` wrapper — `tsx` spawns a child node process that survived, kept its port bound, and was reparented to init | A stray ADP server outliving the run: finding 3's phantom-404 arriving by a second route. Caught by `verify-clean.sh` after a real run. **Fixed** by signalling the process group. |
| 12 | Two e2e tests `mkdtemp`'d directories nothing ever removed — one of them in a test that asserts a clone *fails*, so no later cleanup statement is reached | One leaked `/tmp` directory per run, per test. **Fixed.** |

The pattern is worth naming: each of these was invisible precisely because the environment
was dirty in a way that happened to be *benign*. Making the environment reproducibly clean is
what turned them into failures — which is the argument for the whole exercise.

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

A PowerShell entrypoint (`tools/win/Run-CleanTest.ps1`) that creates a throwaway distro with
`wsl --install --name`, clones the repo into it, runs bootstrap → Layer 1 → the full suite →
teardown inside it, then `wsl --unregister`s it. (`--install --name` rather than `--import` from a
cached rootfs tarball: it needs WSL 2.4.4+, but Microsoft distributes and caches the image, which
is a great deal less code than managing tarballs.)

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
Makefile                          # doctor | up | test | test-all | down | nuke — one entrypoint  [done]
scripts/dev/config.sh             # constants only: canonical DSN, prefixes, pinned Node major    [done]
scripts/dev/lib.sh                # logging helpers on top of config.sh                           [done]
scripts/dev/doctor.sh             # versions, ports, orphans, docker reachability                  [done]
scripts/dev/verify-clean.sh       # asserts zero adp-test-* containers/volumes/procs/tempdirs      [done]
server/test/require-db.ts         # turns a silent e2e skip into a hard failure                    [done]
server/test/global-setup.ts       # migrate once, before any suite (finding 10)                    [done]
.nvmrc                            # 22                                                             [done]
deploy/docker-compose.test.yml    # Postgres only, tmpfs, ephemeral port, no restart policy         [done]
scripts/dev/up.sh                 # ephemeral compose, wait healthy, discover port, emit .env.test [done]
scripts/dev/down.sh               # compose down -v --remove-orphans, then verify                   [done]
scripts/dev/env.sh                # generate .env.test: random SIGNING_KEY, discovered port         [done]
scripts/dev/bootstrap.sh          # bare Ubuntu -> provisioned (apt, docker.io, Node 22)       [done]
.github/workflows/clean-room.yml  # bare-metal + full-loop jobs, so bootstrap cannot rot       [done]
docs/manual-test-plan.md          # the walkthrough for a human, with per-step automation status [done]
server/acceptance/run.sh          # the §2.1 definition-of-done walkthrough, executable          [done]
server/acceptance/ui.spec.ts      # C9-C12 in a real browser, with screenshots                   [done]
tools/win/Run-CleanTest.ps1       # create distro -> clone -> bootstrap -> test -> unregister    [done]
```

CI does **not** yet call these targets — it still runs its own step list, and it uses a Postgres
service container rather than this compose stack, so `make up` does not apply to it unchanged.
Converging the two is Phase 2 work, landing with `clean-room.yml`. Until then the Makefile and
CI can drift, and `make test-all` is deliberately ordered to mirror CI's steps so the drift is
at least visible.

### Two invariants that make the difference

**Every script registers a `trap` cleanup.** `server/conformance/run.sh` was the model here —
and then turned out to have the subtle version of the bug: its trap fired correctly but killed
only the `npx` wrapper, leaving the real server running (finding 11). Cleaning up the pid you
started is not the same as cleaning up the process tree you caused.

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

### Phase 1 — ephemeral dependencies *(done)*

`deploy/docker-compose.test.yml` + `Makefile` + `up`/`down`/`env`. Namespaced per checkout and
per run, tmpfs state, no restart policies, host port discovered with `docker compose port`.

Closes findings 3, 4 and 6, and exposed findings 10, 11 and 12 — all now fixed.

Verified end to end on 2026-08-01: `make up` → `make test-all` (typecheck, build, migrate,
**113 passed / 0 skipped** — the whole suite as it stood at that commit, against a database
created seconds earlier — plus the web build and the real-`gh` conformance gate) → `make down`
reporting a completely clean machine. The suite has since gained a test on `main`; the count is
recorded as the dated observation it was, not as a number to keep in sync.

### Phase 2 — bootstrap from bare metal *(done)*

`scripts/dev/bootstrap.sh` takes a bare Debian/Ubuntu system to "can run the suite": system
packages, Node 22 from NodeSource, distribution `docker.io`, and `npm ci` for both workspaces.
Idempotent — every step checks before it acts, so re-running after a failure is safe.

`.github/workflows/clean-room.yml` is what keeps it true, and it is deliberately *not* `ci.yml`.
`ci.yml` optimizes for fast feedback: `actions/setup-node`, a Postgres service container, cached
dependencies — none of which a tester on a new laptop has, which makes it a poor witness for
"can someone actually set this up?". The clean-room workflow provides none of that. Two jobs:

- **`bare-metal`** runs in a stock `ubuntu:24.04` container with only git, curl and
  ca-certificates preinstalled — the irreducible pre-clone minimum, since you cannot check out a
  repo without git. Everything else is bootstrap's job. It then asserts the toolchain is what was
  asked for, runs the unit and integration tiers, and **runs bootstrap a second time** to prove
  idempotency.
- **`clean-room`** runs on a normal runner with a working Docker daemon and does the full loop:
  bootstrap → `verify-clean --strict` → `up` → `test-all` → `down` → `verify-clean --strict`.
  The final assertion is the one the workflow exists for.

Closes finding 2.

**Why NodeSource rather than fnm/nvm.** A version manager is the better developer tool and the
repo's `.nvmrc` supports it, but it installs per-user and needs a shell hook to be on `PATH`. A
provisioning script wants the boring system-wide answer that works in the next shell, in a
service, and in a CI step without ceremony.

**One honest gap.** Neither CI job exercises the `apt-get install docker.io` path: `bare-metal`
passes `--skip-docker` (Docker-in-Docker inside a job container is a different problem), and
`clean-room` runs on a runner where Docker is already present, so bootstrap takes its
already-reachable branch. It is the one part of Phase 2 that can rot without CI noticing, and the
part Phase 4's disposable distro depends on most.

It was verified by hand instead, in a privileged `ubuntu:24.04` container — and that verification
earned its keep immediately. The first version launched the daemon as
`service docker start || dockerd &`, which fails two ways at once: the daemon becomes a child this
script blocks in `wait()` forever, *and* it inherits the script's stdout, so any caller that pipes
bootstrap's output never sees EOF. GitHub Actions pipes every `run:` step — the `clean-room` job
would have hung until its job timeout on the first push, with no error to explain it. The daemon
is now launched through an inner shell that exits immediately, and the regression test pipes
bootstrap's output deliberately, because piping is what exposed it.

The general lesson, which applies to anything Phase 4 adds: **a background process must not
inherit the launching script's stdout.** Redirecting the command is not enough — the backgrounded
shell holds the descriptor too.

#### What a container could not tell us

Containers were not enough. Running `bootstrap.sh` on a real WSL machine during Phase 3 — an
Ubuntu 26.04 distro that had Docker Desktop installed and broken — surfaced four more bugs, none
of which any container could have shown, because each depends on state a fresh image does not
have:

| Bug | Why containers missed it |
|---|---|
| The engine install was skipped entirely: `docker_state` reported "client present, daemon unreachable", which the script read as "installed but stopped". The client was Docker Desktop's WSL-integration symlink into `/mnt/wsl/docker-desktop/`, a mount that exists only while Desktop runs — so it dangled, and the script tried to start a `dockerd` that was never installed. Now keyed on `dockerd`, the thing it is about to start. | A container has no Docker Desktop, so `docker` is either properly installed or absent — never a dangling symlink to a stopped Windows app |
| `docker.io` installs the engine and CLI but **not** the compose plugin, so bootstrap reported `bootstrap: ok` on a machine where `make up` could not work. `doctor` caught it correctly, but bootstrap should not have got there. The compose check is now unconditional — a machine can have a healthy daemon and no plugin. | Every container run either skipped Docker or ran where compose was already present |
| The group-add was keyed on `$USER` and a non-empty `$SUDO`, so `sudo bash bootstrap.sh` — the normal way a human runs it — skipped it entirely and installed a daemon the user then could not reach. Now uses `$SUDO_USER`. | Containers run as root, where there is no one to add and the branch is correctly skipped |
| The daemon-failure hint named `/var/log/docker.log`; the script writes `/var/log/dockerd.log`. It now prints the log inline instead of naming it. | The hint only fires on failure, and the daemon always started in a privileged container |

Two of these made bootstrap claim success on a machine it had left unusable. That is worse than
failing, and it is the specific risk of testing a provisioning script only in the environment it
was written against. **A container is a clean machine; a developer's laptop is a dirty one, and
the dirt is the point.** Phase 4's disposable distro is the honest middle: fresh enough to be
reproducible, real enough to be WSL.

### Phase 3 — the manual suite, executable *(done)*

`docs/manual-test-plan.md` is the §2.1 definition of done written out as steps a person can
follow, with an honest per-step record of what is automated. `server/acceptance/run.sh` is the
same walkthrough executable, and `server/acceptance/ui.spec.ts` drives the last steps in a real
browser. `make acceptance` runs it; `make acceptance-ui` adds the browser.

It is related to but deliberately separate from `conformance/run.sh`. That gate asks one narrow
question — "does a real, unmodified `gh` work against this server?" — and stays narrow so it
remains a stable compatibility signal. Acceptance asks the whole §2.1 question, including what
`gh` cannot see: the evidence bundle, the operation log, and undo.

Closes finding 8 — the UI build stops being optional, because `run.sh` fails outright if
`server/web/dist` is missing rather than letting the server skip `/ui/*` with a log line.

**Undo is performed, not simulated.** §2.1 says the human *clicks undo*, so with the UI enabled
the Playwright spec clicks the button and `run.sh` asserts only the consequence — that `main`
moved back server-side, checked with `git rev-parse` against the bare repo. An API response
saying "ok" is not evidence that a merge was reverted.

**Screenshots are the deliverable for what stays manual.** Whether the UI *reads well* is a human
call that cannot be asserted. Five screenshots per run (`.adp-test/acceptance/`, uploaded as a CI
artifact) reduce that call to a minute of looking rather than a full manual walkthrough.

#### The one part of §2.1 that is not met

"Watches `gh pr checks` go green" **does not work today**, and the acceptance suite says so out
loud. The rollup *state* is real and correct — `statusCheckRollup { state }` resolves to `SUCCESS`
and the land policy gates on it — but `gh pr checks` enumerates `contexts`, which
`http-gql/resolvers.ts` returns as a deliberately empty connection. So `gh` reports "no checks
reported" and exits non-zero however green the rollup is. Confirmed against the real pinned `gh`
binary, not inferred.

`run.sh` asserts **both** halves: the rollup is `SUCCESS`, *and* `gh pr checks` still fails in
exactly this way. The second assertion is the useful one — when per-context detail gets
implemented, that test fails and demands the gap be closed in `manual-test-plan.md` and the
README's `gh` table, instead of passing quietly and leaving three documents describing a
limitation that no longer exists.

#### Bugs found by running it

The suite was written by reading the code and then corrected by executing it — every one of these
was a wrong guess about a shape never observed:

- **`Repository.object(oid:)` has no resolver.** The rollup check queried it and got `null`, which
  would have read as "the gate never landed" forever. Commits are reachable through
  `PullRequest.commits` — the same traversal `gh pr checks` performs.
- **`Content-Type: application/json` on a bodyless POST** made Fastify reject every undo with a
  400 (`FST_ERR_CTP_EMPTY_JSON_BODY`). `server/web/src/api.ts` already sets the header only when
  there is a body; the shell helper now does the same.
- **A Playwright selector matched a form control instead of data.** `getByText("issue.create")`
  resolved to the hidden `<option>` in the op-log verb filter rather than the log row, failing with
  "unexpected value: hidden". Now scoped to `.list-row`. A test that asserts on a filter dropdown
  rather than on the rows it filters would have passed against an empty log.

### Phase 4 — the Windows entrypoint *(done)*

`tools/win/Run-CleanTest.ps1` creates a throwaway WSL distro, clones the repo into it, runs
`bootstrap.sh` and the full loop, and then unregisters the distro:

```powershell
.\tools\win\Run-CleanTest.ps1                          # main, in a fresh distro, destroyed after
.\tools\win\Run-CleanTest.ps1 -Ref my-branch           # exercise a PR before merging it
.\tools\win\Run-CleanTest.ps1 -KeepDistro              # keep it on failure, to inspect
```

It installs nothing on Windows; the only prerequisite is WSL. **The distro is the teardown
guarantee.** `make down` asserts nothing leaked; this removes the filesystem those things lived
on, so "returned the machine to its prior state" becomes structural rather than a claim to audit.
`make down` still runs first — a leak regression should fail here too, not be hidden by the
`--unregister` that follows.

It clones from the remote by default rather than copying the local tree, because that is what a
tester actually does, and it is the only way the "brand new machine" path gets exercised honestly.
`-Ref` covers testing an unmerged branch.

**Keep that file ASCII-only.** Windows PowerShell 5.1 — still the default on a new Windows
machine, which is precisely the machine this targets — reads a BOM-less file as ANSI, not UTF-8.
A single em dash in a comment becomes mojibake that derails the parser, and the reported error
points at an unrelated line much further down. This cost a debugging cycle when the script was
first written, hence the comment at the top of it.

#### Why this is the layer that would have caught the bootstrap bugs

Phase 2's bootstrap was verified only in containers, and Phase 3 then found four bugs in it that
containers structurally could not show (see above) — two of which made bootstrap report success on
a machine it had left unusable. A disposable WSL distro is the missing middle: a real WSL
environment with no systemd, real `apt`, and a genuine fresh-machine package set, but reproducible
and free to destroy.

Running it on every change is too slow for an inner loop; running it never is how the four bugs
survived. On demand before a release, and on a schedule, is the right cadence.

**Verified on 2026-08-01**, on a Windows machine with WSL 2.7.10: a fresh `Ubuntu-24.04` distro
created from nothing, the repo cloned from GitHub, `bootstrap.sh` installing `make`, Node 22 from
NodeSource and `docker.io` + `docker-compose-v2`, then `make doctor` → `make up` (Postgres on
ephemeral port 32768) → `make test-all` (**114 passed, 0 skipped**, plus the real-`gh` conformance
gate) → `make down` reporting a clean machine → the distro unregistered and its directory removed.
**16m03s**, start to finish, leaving nothing behind.

That run is also the first time `apt-get install docker.io` was exercised in real WSL rather than
a privileged container — the gap Phase 2 flagged as the piece most likely to rot unnoticed.

**Two quirks worth knowing.** `wsl.exe` translates the *caller's* working directory into the
target distro, so running this from a `\\wsl.localhost\<other-distro>\...` path emits
`Failed to translate ...` on every invocation; it falls back and still works, but the script now
passes `--cd /` so the log does not read like a fatal error. And unregistering a distro can
briefly break WSL's binfmt interop in *other* distros — `wsl.exe` returns "Exec format error" for
a moment afterwards. Nothing is lost; it recovers on its own.

---

## 6. Usage (as it exists today, after Phases 0–2)

From Windows, with nothing but WSL installed — creates a throwaway distro, runs everything, and
deletes it:

```powershell
.\tools\win\Run-CleanTest.ps1
```

Or, starting from a shell in a WSL distro that has never seen this project:

```bash
sudo apt-get update && sudo apt-get install -y git   # the pre-clone minimum
git clone <repo> adp && cd adp
bash scripts/dev/bootstrap.sh                        # toolchain, Docker, dependencies
```

Then the loop, on any machine:

```bash
make doctor         # can this machine run the suite at all?
make up             # ephemeral Postgres on a discovered port, writes .env.test
make test-all       # typecheck, build, migrate, suite, web, conformance, acceptance
make acceptance-ui  # the §2.1 walkthrough with the web UI in a real browser
make down           # tear down, then assert the machine is clean
```

`make acceptance-ui` needs Chromium's system libraries, which require root. They are installed
separately and once, so that no ordinary target can trigger a password prompt half way through:

```bash
sudo npx --prefix server playwright install-deps chromium
```

`make down` ends by running `verify-clean.sh`, so teardown is asserted rather than assumed. A
clean result looks like this, and any leaked container, volume, network, server process or temp
directory shows up as a named warning instead:

```
== processes ==
  ok    no stray ADP server processes
== temp directories ==
  ok    no stale temp directories
verify-clean: ok
```

Recovery paths, for when a run was killed hard enough to skip its trap:

```bash
make down-all                          # sweep every adp-test-* project on the machine
bash scripts/dev/verify-clean.sh --fix # remove leaked resources and generated files
make nuke                              # the above, plus deps, build output and the gh cache
```

`make up` requires Docker. Without it, point the suite at any Postgres you like and skip the
container layer entirely:

```bash
bash scripts/dev/env.sh postgres://user:pass@host:5432/db && make test
```

### On the e2e skip

Without `ADP_REQUIRE_DB`, a missing `DATABASE_URL` still skips the e2e tier — that keeps
`npm test` (`make test-unit`) usable on a machine with no database, which was the original and
legitimate reason for the skip. The change is that any context which *intends* full coverage now
says so explicitly and gets a hard failure instead of a green partial run. `make up` writes
`ADP_REQUIRE_DB=1` into `.env.test`, so everything downstream of a real stack is enforced by
default.

---

## 7. What is left

The plan's four phases are done. These are the honest remainders, listed so they are not
rediscovered as surprises.

**CI does not call the Makefile targets.** `ci.yml` still runs its own step list against a
Postgres service container. `clean-room.yml` does use them, so the targets cannot rot entirely,
but the two definitions of "what CI runs" can still drift. `test-all` deliberately mirrors
`ci.yml`'s step order so the drift stays visible. Converging them means either teaching `ci.yml`
to use `make up` or accepting that it optimizes for a different thing (fast feedback) than the
clean-room workflow does (fidelity) — a real decision, not an oversight.

**No CI job installs `docker.io`.** `bare-metal` passes `--skip-docker`; `clean-room`'s runner
already has an engine, so bootstrap takes its already-reachable branch. That path is now covered
by `Run-CleanTest.ps1` on a real Windows machine, but that runs on demand rather than per push.
A scheduled run would close the gap.

**`gh pr checks` does not go green.** The §2.1 gap documented above: the rollup state is real,
`contexts` is an empty connection. `acceptance/run.sh` asserts the current behavior so that
implementing per-context detail forces the docs to be corrected.

**Screenshots are reviewed by a human or not at all.** Nothing asserts that the UI looks right,
by design. The screenshots make that review cheap; they do not make it automatic.

**Phase 4 is a local tool, not a gate — decided.** `Run-CleanTest.ps1` exists so a human can
answer "does this work from nothing?" on demand. It is deliberately **not** wired into CI and
should not be: it needs a Windows host, takes ~16 minutes, and a self-hosted Windows runner is
real infrastructure to buy, secure and maintain in exchange for catching a class of bug that
`clean-room.yml` already catches most of on every push. Run it before a release, after touching
`bootstrap.sh`, or when a fresh-machine claim needs proving. Do not add it to a workflow.

The remaining coverage gap it leaves — nothing automatically exercises `apt-get install docker.io`
— is real but small, and is better closed by the dev environment in
[`environments-plan.md`](environments-plan.md) than by a Windows runner.
