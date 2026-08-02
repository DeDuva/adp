# Manual test plan

The definition of done in [`pragmatic_mvp.md`](pragmatic_mvp.md) §2.1, written out as steps a
person can actually follow, and annotated with what is automated.

> Set three environment variables. An off-the-shelf coding agent — no MCP config, no code changes,
> no ADP knowledge — completes a full development cycle with no GitHub involved: `git clone`s, reads
> the issue with `gh issue view`, edits, pushes, `gh pr create`, watches `gh pr checks` go green,
> `gh pr view` shows a typed review, `gh pr merge` lands it. A human then opens the ADP web UI and
> sees the intent, the signed evidence bundle, the provenance (harness / model / session), the
> operation log — and clicks undo.

**This document exists to be deleted.** Every step here should end up in
`server/acceptance/run.sh`, and the ones that remain manual should be manual for a stated reason,
not because nobody got to them. The automation column is the honest record of where that stands.

| | Steps | Automated by |
|---|---|---|
| A | Environment | `scripts/dev/bootstrap.sh`, `make up` |
| B | The agent's loop (1–8) | `server/acceptance/run.sh` |
| C | The human's supervision (9–12) | `server/acceptance/ui.spec.ts` (Playwright) |
| D | The M2 trust-plane ramp (13–19) | `server/acceptance/run.sh` |
| E | Teardown | `make down` |

Run the whole thing with `make acceptance`. What follows is what that command does, in a form you
can step through by hand when something breaks and you need to find out where.

---

## Part A — environment

**A1. Provision the machine.** On a system that has never seen this project:

```bash
bash scripts/dev/bootstrap.sh
```

*Expect:* every section reports `ok`, ending in `bootstrap: ok`. On a machine that already has
Node 22 and Docker, the install steps short-circuit and this takes seconds — that is correct
behavior, not a skipped step.

**A2. Bring up dependencies.**

```bash
make up
```

*Expect:* `postgres healthy`, a `postgres on localhost:<port>` line with an ephemeral port that
differs run to run, and `.env.test` written. If the port is 5432 every time, something is wrong —
the test stack is supposed to take whatever Docker gives it.

**A3. Load the environment.**

```bash
set -a; . .env.test; set +a
```

---

## Part B — the agent's loop

This is the part an unmodified agent does. Nothing below requires ADP-specific knowledge; every
command is `git` or `gh` pointed at the server.

**B1. Point `gh` at the server.** `gh` treats any non-`github.com` host as GitHub Enterprise
Server and derives `https://HOST/api/v3/`, which is where ADP mounts. Note
`GH_ENTERPRISE_TOKEN`, not `GH_TOKEN` — that is the variable `gh` reads for a non-GitHub host.

```bash
export GH_HOST=<host>
export GH_ENTERPRISE_TOKEN=<token>
```

*Expect:* `gh auth status` reports the host.

> `gh` refuses plain HTTP for any non-`github.com` host, so a local run needs TLS in front of the
> server. `acceptance/run.sh` mints a throwaway self-signed cert and runs a proxy for exactly this
> reason; by hand, that is the fiddliest part of the walkthrough.

**B2. Clone.**

```bash
git clone https://x-access-token:<token>@<host>/<owner>/<repo>.git
```

*Expect:* a normal clone. This is the real `git http-backend` behind auth middleware, so anything
git does against GitHub works here.

**B3. Read the task.**

```bash
gh issue view 1
```

*Expect:* the issue title and body. The issue **is** a typed intent server-side — that projection
is the point, and the agent never has to know.

**B4. Edit and push.**

```bash
git checkout -b feature && echo "change" >> README.md
git commit -am "implement the thing" && git push origin feature
```

*Expect:* the push succeeds. Server-side, the `post-receive` hook has now auto-recorded a signed
`changes` row for the commit, with provenance from the pushing identity. Nothing in the agent's
output says so — verified in step 10.

**B5. Propose.**

```bash
gh pr create --base main --head feature --title "..." --body "..."
```

*Expect:* a PR URL.

**B6. Watch checks go green.** A gate result has to be reported before there is anything to watch;
ADP receives and attests results, it never executes them (same division of labor as GitHub's Checks
API):

```bash
curl -X POST "$PUBLIC_URL/api/v3/repos/<owner>/<repo>/gates" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"git_sha":"<sha>","name":"test","status":"success","summary":"12 passed"}'

gh pr checks 1
```

*Expect:* **`gh pr checks` reports "no checks reported" and exits non-zero — this is the one part
of §2.1 that is not met today.** The rollup *state* is real and correct (`SUCCESS`), and the land
policy gates on it, but `gh pr checks` enumerates `contexts`, which
`http-gql/resolvers.ts` returns as a deliberately empty connection. So there is nothing for `gh` to
list, however green the rollup is.

Verify the part that does work directly:

```bash
gh api graphql -f query='query { repository(owner:"<owner>", name:"<repo>") {
  object(oid:"<sha>") { ... on Commit { statusCheckRollup { state } } } } }'
```

*Expect:* `"state": "SUCCESS"`.

`acceptance/run.sh` asserts both halves — the rollup is `SUCCESS`, *and* `gh pr checks` still
fails in exactly this way. The second assertion is deliberate: when per-context detail gets
implemented, that test fails and demands the gap be closed here and in the README's `gh` table,
rather than quietly passing and leaving three documents claiming a limitation that no longer
exists.

**B7. Get a typed review.**

```bash
curl -X POST "$PUBLIC_URL/api/v3/repos/<owner>/<repo>/pulls/1/reviews" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"state":"approved","body":"looks good"}'

gh pr view 1
```

*Expect:* the review appears. Review states are typed, not parsed out of comment prose.

**B8. Land it.**

```bash
gh pr merge 1 --merge
```

*Expect:* success — but only because B6 and B7 happened first. The instance land-policy floor is
`gates_green,one_approval`. **Worth doing deliberately once:** try the merge before approving and
confirm it is refused with a `422` naming the unmet requirement. A policy that has never been seen
to refuse anything has not been tested.

---

## Part C — the human's supervision

Part B is what an agent sees. Part C is the claim that a human can audit and reverse it, which is
the half GitHub has no analogue for.

**C9. Open the UI.** Browse to `<host>/ui/`, and connect with a token, owner and repo.

*Expect:* the connect form accepts the token and the Issues list renders. If `/ui/` 404s, the web
UI was never built — `npm run build --prefix server/web`. The server skips serving `/ui/*` with
only a log line when `server/web/dist` is missing, so this fails quietly.

**C10. See the intent, evidence, and provenance.** Open the pull request, then **View evidence**.

*Expect:* a `Change (intent, provenance, signature)` panel — the intent the change was bound to,
a **Provenance** block naming the pushing identity (and harness / model / session where the client
supplied them), and a **Signature**. This is the assertion the whole thesis rests on: the *why* and
the *how it was verified* are one signed record, not two systems that have to be joined by hand.

**C11. Read the operation log.** Open **Operation log**.

*Expect:* one row per mutation — issue filed, change recorded, proposal opened, review added, merge
landed — each with actor and timestamp. Every mutation writes its row in the same database
transaction as the mutation itself, so the log cannot drift from what happened.

**C12. Undo the merge.** Find the merge operation and undo it.

```bash
curl -X POST "$PUBLIC_URL/api/adp/repos/<owner>/<repo>/operations/<id>/undo" \
  -H "Authorization: Bearer <token>"
```

*Expect:* the call succeeds, and `main` server-side points back at the commit it was on before the
merge. Verify that directly rather than trusting the response:

```bash
git --git-dir=$GIT_ROOT/<owner>/<repo>.git log --oneline main
```

The undo is itself an operation, so the log now records the reversal too.

---

## Part D — the M2 trust-plane ramp

Everything in Part B and C is the M1 definition of done. M2 (`pragmatic_mvp.md`) added six more
surfaces on top of it — this part exercises each one for real, against the same running server,
reusing the repo Part B already set up.

**D13. Telemetry.** REST and GraphQL traffic has been flowing since Part B — read it back.

```bash
curl "$PUBLIC_URL/metrics"
```

*Expect:* Prometheus text format (`# TYPE ... counter` lines), with at least one
`adp_http_requests_total{...}` line and one `adp_graphql_operations_total{...}` line carrying a
nonzero count — proof the counters are wired to real requests, not just present and empty.

**D14. The `adp` CLI.** A second client against the same REST surface `gh` and `curl` have been
using — build it once, then point it at the server the same way `gh` was pointed at it (`ADP_TOKEN`/
`ADP_SERVER_URL`, the CLI's own equivalent of `GH_ENTERPRISE_TOKEN`/`GH_HOST`).

```bash
npm ci --prefix cli && npm run build --prefix cli
ADP_SERVER_URL="$PUBLIC_URL" ADP_TOKEN=<token> node cli/dist/index.js pr list --repo <owner>/<repo>
```

*Expect:* JSON listing the PR Part B merged, `state: "MERGED"`. The CLI is a thin wrapper over the
same endpoints `gh` and the acceptance script's `curl` calls use — this is the same data, a third way.

**D15. Outbound webhooks.** Register a hook, then trigger a real signed delivery to it.

```bash
curl -X POST "$PUBLIC_URL/api/v3/repos/<owner>/<repo>/hooks" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"config":{"url":"http://<listener>/","secret":"<secret>"},"events":["push"]}'
```

Push a new commit, then check whatever `<listener>` received.

*Expect:* a POST carrying `X-ADP-Event: push` and `X-Hub-Signature-256: sha256=<hmac>` — GitHub's
own header shape, verified with the same secret configured above — and a JSON body naming the ref,
before/after shas, and the pushing identity. `core/webhooks.ts` retries a failing delivery three
times before giving up and logging; a listener that is actually up gets it on the first attempt.

**D16. A scanner-as-gate adapter.** ADP never runs the scanner — an adapter translates output the
scanner already produced. `osv-scanner`'s adapter needs no install (zero runtime dependencies):

```bash
node adapters/osv-scanner/run.mjs --json adapters/test/fixtures/osv-scanner-real.json \
  --repo <owner>/<repo> --sha <sha> --server "$PUBLIC_URL" --token <token>
```

*Expect:* `osv-scanner gate reported: failure — ...`, and the evidence bundle for `<sha>`
(`GET /api/adp/repos/<owner>/<repo>/evidence/<sha>`) now carries a `gates` entry named
`osv-scanner`, DSSE-signed like every other gate result.

**D17. Dependency admission.** A lockfile diff becomes a typed, per-package verdict — live against
the real OSV.dev API, not a mock:

```bash
curl -X POST "$PUBLIC_URL/api/v3/repos/<owner>/<repo>/dependency-admission" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"git_sha":"<sha>","packages":[{"ecosystem":"npm","name":"is-odd","version":"3.0.1"},{"ecosystem":"npm","name":"sdxcode1","version":"9.9.9"}]}'
```

*Expect:* HTTP 201, `status: "failure"` — `is-odd@3.0.1` admits clean, but `sdxcode1@9.9.9` is a
real package OpenSSF's Malicious Packages project has reported (queried through the same
`api.osv.dev` endpoint ordinary CVE lookups use), and its `reasons` names the `MAL-` advisory id.
A `block` verdict on any package outranks an `admit` on the rest — the gate as a whole fails.

**D18. SBOM per land.** Push a branch that adds a `package-lock.json`, land it, and read back the
SBOM that generated automatically — no separate "generate SBOM" step exists; it happens as part of
every merge, the same way `gh pr merge` triggered gate evidence in Part B.

Hand-build a minimal lockfile rather than copying one straight from `npm install`: real lockfiles
carry base64 `integrity` hashes (`sha512-...`), and those are exactly high-entropy enough to trip the
real pre-receive secret scanner this push actually goes through — the same scanner B4's push went
through, just without anything in it worth flagging. `core/sbom.ts` only reads each package's name
and version anyway, so a lockfile with just those two fields per package produces the identical SBOM.

```bash
gh pr merge <n> --repo <host>/<owner>/<repo> --merge
curl "$PUBLIC_URL/api/adp/repos/<owner>/<repo>/evidence/<head-sha>"
```

*Expect:* a `gates` entry named `sbom`, `status: "success"`, whose DSSE envelope decodes to a
`predicateType: "https://cyclonedx.org/bom"` statement listing the packages the lockfile named.
Keyed by the PR's head sha (the commit CI actually validated), same as every other gate — not the
resulting merge commit.

**D19. Mirror mode.** ADP sitting alongside a repo that stays on GitHub — outbound (ADP → GitHub)
and inbound (GitHub → ADP) are separate flows, both exercised here against a plain local bare repo
standing in for GitHub (no live GitHub credential needed to prove the mechanism).

```bash
ADP_SERVER_URL="$PUBLIC_URL" ADP_TOKEN=<token> node cli/dist/index.js repo mirror <owner>/<repo> \
  --remote-url "file:///path/to/standin.git" --secret <whsec> --credential <pat> --direction both
git push origin main   # into ADP, as usual
```

*Expect (outbound):* within one poll interval (`MIRROR_POLL_INTERVAL_MS`, 5s by default), the commit
appears on the stand-in repo's `main` — `git --git-dir=/path/to/standin.git log --oneline main`.
`GET .../mirror` shows `last_outbound_sha` matching and a `recent_sync_log` entry with
`status: "success"`.

For inbound, push straight to the stand-in repo, then replay GitHub's own webhook shape at ADP,
signed with the `webhook_secret` the mirror creation call returned:

```bash
curl -X POST "$PUBLIC_URL/webhooks/github/<owner>/<repo>" \
  -H "Content-Type: application/json" -H "X-Hub-Signature-256: sha256=<hmac-of-body>" \
  -d '{"ref":"refs/heads/main","after":"<sha>"}'
```

*Expect:* `{"ok":true}`, ADP's own `main` now resolves to `<sha>`, and the evidence bundle for
`<sha>` shows a change whose provenance names `"via": "mirror-inbound"` — auto-recorded exactly
like an ordinary push, just from the other direction.

---

## Part E — teardown

**E20. Tear it all down.**

```bash
make down
```

*Expect:* `verify-clean: ok` with no warnings — no leftover containers, volumes, networks, server
processes, temp directories or generated files. Teardown is asserted here, not assumed; if you see
a warning, it names exactly what leaked.

**E21. Return the machine.** `make down` leaves the toolchain installed, which is usually what you
want. To go further:

```bash
make nuke   # also removes dependencies, build output and the pinned gh cache
```

For a true "return the machine to its prior state," the toolchain has to go too. That is what the
Windows entrypoint does — it runs everything above inside a throwaway WSL distro and then deletes
it, so there is nothing left to clean up:

```powershell
.\tools\win\Run-CleanTest.ps1
```

Nothing is installed on Windows; the only prerequisite is WSL itself. Use this when the question
is "does the whole thing work from nothing?" rather than "did my change break something?"

---

## What stays manual, and why

| Step | Status | Reason |
|---|---|---|
| B1–B8 | **Automated** | `server/acceptance/run.sh`, against a real pinned `gh` binary |
| C9–C11 | **Automated** | `server/acceptance/ui.spec.ts` drives a real browser and saves screenshots |
| C12 | **Automated** | the undo is asserted against the server-side ref, not the API response |
| D13–D19 | **Automated** | `server/acceptance/run.sh`, against the same live server B and C already used — real signed webhook delivery, real `api.osv.dev` lookups, a real `osv-scanner` fixture, and a plain bare repo standing in for GitHub for mirror mode |
| Visual judgment | **Manual, permanently** | automation asserts the data is present and rendered; whether the UI *reads well* is a human call. The screenshots exist so that call takes a minute, not a full walkthrough. |
| A1 on genuinely new hardware | **Manual, rarely** | CI's `bare-metal` job covers a bare container every push, which is the same provisioning problem; a physical machine adds only driver and BIOS variance, which this project cannot meaningfully test |
