# M4 exit criterion 5 — runner isolation, ratified

**Status: met, 2026-08-22.** This document is the ratification the criterion asks for. It exists
because the criterion's own standard is that isolation be shown "not as hoped", and until now the
proofs existed while nothing recorded that they added up to the criterion.

> **The runner isolates as designed**, not as hoped: a gate script that attempts a host-mount, an
> unbounded network call, or a resource-cap violation is refused or killed, and the refusal is
> itself recorded — the same "a skipped check must never look like a passing one" standard
> `AGENTS.md` already holds the test suite to, applied to the thing the test suite is checking.
>
> — [`docs/m4-readiness-review.md`](m4-readiness-review.md) §5, criterion 5

Ratifying it required two tests that did not exist. Both are named below. The rest was already
there and is inventoried here so the claim is checkable rather than asserted.

## 1. The three attack shapes

Every row is a **real-daemon** test: `docker create`/`cp`/`start` against the actual daemon, not a
mocked child process. That distinction is the point — an argument-list assertion proves the flag
was passed, not that the daemon acted on it, and the two come apart exactly when someone changes
how the arguments are built.

| Attack shape | Proof | File |
|---|---|---|
| **Host-mount** — reach the host filesystem | A host file at a known absolute path is invisible from inside, and `/var/run/docker.sock` does not exist | `runner/src/docker.test.ts` · "cannot see the host filesystem or the Docker socket" **(new)** |
| | The checkout arrives by `docker cp`, not a bind mount | · "makes the checkout's files visible inside the container at /workspace" |
| **Unbounded network call** | A real outbound call from inside the container fails | · "really cannot reach the network" |
| **Resource-cap violation** | A fork bomb dies inside the container, not on the host | · "the pids limit really binds" |
| | A container outliving its timeout is killed and reported `timed_out` | · "kills a container that outlives its timeout" |
| | `chown` as in-container root is refused — `--cap-drop=ALL` really applied | · "capabilities are really dropped" |

The socket half of the first row is the one with teeth. `docs/pragmatic_mvp.md` §4.5's stated reason
for putting the runner on its own host is that **"a mounted Docker socket is root on the host"**. A
socket mounted into a gate container would hand every gate script exactly that, silently, while
every other isolation test kept passing — the argument-list assertion (`buildCreateArgs` contains no
`-v`) cannot see it, because the mount would be spelled correctly.

## 2. "And the refusal is itself recorded"

The clause that turns isolation from a property of the container into a property of the system. Each
proof above ends with the runner reporting a **non-succeeded** status; this is what happens next.

| Property | Proof |
|---|---|
| A `timed_out` or `error` gate writes a signed `gate_results` row with verdict **`failure`** | `server/test/e2e-gate-jobs.test.ts` · "records a '%s' gate as signed FAILURE evidence" **(new)** |
| …and a `gate_job.complete` operation, in the same transaction as the status flip | same test |

`toGateResultStatus` (`server/src/http-rest/gate-jobs.ts`) maps *every* non-`succeeded` status to
`failure`, which is the value land policy's `gates_green` reads. The failure mode this excludes is
quiet: if a killed gate wrote no evidence, `gates_green` would see no failing gate, and a commit
whose gate was killed mid-run would land as though nothing had happened. That is precisely "a
skipped check must never look like a passing one", applied to the thing doing the checking.

## 3. The skip guard

The isolation tier can skip itself when Docker is unreachable, which would make the whole of §1
vacuous on a machine without a daemon. `ADP_REQUIRE_DOCKER=1` turns that skip into a hard failure at
import time (`runner/test/require-docker.ts`), and it is set unconditionally in CI
(`.github/workflows/ci.yml`) and by `make check` (`Makefile`). Same mechanism as `ADP_REQUIRE_DB=1`,
for the same reason.

## 4. Each proof was verified able to fail

A passing test proves nothing until it has been seen to fail. Every proof marked **(new)** was
checked by mutating the code it guards:

| Mutation | Caught by |
|---|---|
| `-v /tmp:/tmp` added to the container args | the host-file marker |
| `-v /var/run/docker.sock:...` added | the socket marker |
| `toGateResultStatus` inverted, so a killed gate reports `success` | the evidence verdict |
| killed gates write no `gate_results` row at all | the evidence-exists assertion |

## 5. What this does NOT claim

Stated because a ratification that only lists what passed is the kind of document that ages badly.

- **Memory and CPU caps are argument-list only.** `--memory` and `--cpus` are asserted in
  `buildCreateArgs`, and no test proves the daemon enforces them, unlike `--pids-limit` and
  `--network none`. They are the two caps whose violation is a noisy-neighbour problem rather than
  an isolation breach, which is why they were left; it is a gap, not a decision that they are
  unnecessary.
- **This is container isolation, not a sandbox against a hostile kernel exploit.** A container
  escape through a kernel vulnerability is out of scope for these tests and for this design. The
  mitigation is the separate host, not the container.
- **The image allowlist is unset by default.** `RUNNER_IMAGE_ALLOWLIST` empty means every image is
  allowed — the single-tenant dev default, stated rather than implied in `runner/src/config.ts`. The
  gate image is repo-controlled, so **a multi-tenant deployment must set it**; nothing in the code
  forces that.
- **Per-gate network allowlisting from `adp.yaml` is not built.** The executor is deny-only
  (`runner/src/docker.ts`). A gate needing a network today cannot have one.
- **Co-location is prevented by configuration, not by code.** The isolation above assumes the runner
  is not on the API's host and has no ambient credential. The Helm chart defaults the runner to off
  and refuses to render without a `nodeSelector` and a runner-scoped token; see
  [`docs/self-hosting.md`](self-hosting.md) §4. An operator who overrides those has left the shape
  this document ratifies.

## 6. What would invalidate this

Any of: a `-v`, `--env`, or `--privileged` appearing in `buildCreateArgs`; `toGateResultStatus`
learning a status it maps to `success`; `ADP_REQUIRE_DOCKER=1` leaving CI; or the runner gaining a
credential beyond the `runner` scope. The first two fail the tests in §1 and §2. The third and
fourth do not — they would make the tests stop running or stop mattering, which is why they are
written down here.
