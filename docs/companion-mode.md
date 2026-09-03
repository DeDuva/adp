# Companion mode — ADP underneath GitHub

**Status:** shipped in 0.7.0. Every capability below is on `main` and has a test.

This is the mode where **GitHub stays your workflow**. Issues, branches, pull requests, reviews,
Actions and the merge button all stay exactly where they are, and ADP sits underneath, recording
what each of them means and publishing its verdict back onto the pull request as a check.

It exists because of one seam. The more faithfully a developer keeps GitHub as their workflow, the
less of ADP's interesting behaviour is authoritative — a repository whose issues, pull requests,
reviews and merges all live on GitHub used to hand ADP a stream of commits and CI verdicts and
nothing that said what any of it was *for*. Companion mode closes that: the intent, the approval,
the merge and the evidence all reach the record without anyone running an ADP command.

The other mode is **native**, where ADP is the forge and `gh` talks to it directly. Native is what
[`README.md`](../README.md)'s `make demo` shows. Companion mode is what you turn on for a
repository you are not moving.

---

## 1. Setting it up

Three commands, from inside the checkout you already have:

```bash
npx @deduva/adp login --server https://adp.example.com --token <token>
npx @deduva/adp init          # detects the GitHub remote and mirrors against it
```

`adp init` creates the org and the repository on your instance, writes down which repository this
checkout is, configures the mirror in both directions, and detects an `adp.yaml` from what the
repository already says about itself. **Mirror is the default rather than a flag** — native mode
asks a team to agree and mirror mode asks one developer to add a remote, and evaluation happens at
the second price.

Then, for the parts that write back to GitHub — the two check runs — install the instance's own
GitHub App:

```
https://adp.example.com/github-app/new
```

That page serves a manifest to GitHub, GitHub creates the App **in your own organisation**, and it
hands the credentials back to the instance that served it. There is no hosted control plane in the
middle holding anyone's keys, which is the point of doing it by manifest rather than by asking you
to create an App and paste four values. The manifest requests exactly the permissions the features
below use and no more, so the installation prompt is answerable; `pull_requests` is **read**,
because GitHub stays the merge authority.

### You do not need a public hostname

Inbound ingest arrives three ways, and they produce one record rather than three similar ones:

| Arrival | Needs | Notes |
|---|---|---|
| **Poller** | nothing | On by default. This is the version that runs on a laptop |
| **Per-repository webhook** | a reachable URL | Immediate rather than polled; `adp init` prints the URL and secret |
| **GitHub App** | a reachable URL | One endpoint for every installation; required for the check runs |

The poller is not a degraded substitute — making the mode that needs no public hostname the one you
have to know to ask for would be backwards. It goes through the same functions the webhook does, so
running both is safe rather than merely unlikely to collide. `MIRROR_INBOUND_POLL_INTERVAL_MS=0`
turns it off on an instance that has a public URL and would rather spend the API calls elsewhere.

Two behaviours worth knowing about the poller: its cursor is the time the poll *started* (writing
"now" at the end opens a window in which an update that landed mid-poll is never looked at again),
and a poll that fails does not advance the cursor at all. A failure on one repository does not
abandon the rest.

---

## 2. The loop, and what ADP has recorded by the end of it

Nothing in this column changes. Every ADP record in the right-hand column is written without a
command being run.

| You, on github.com | What ADP records |
|---|---|
| File an issue | A typed **intent**, and an `issues` row so a trailer can name it |
| Branch and commit | Nothing yet — this is git |
| `git push origin <branch>` | A signed **change** per commit, with harness, model and session where the push carried them |
| Open a pull request | A **shadow proposal**: an ordinary proposal row carrying the upstream number and URL |
| Push again | The proposal's `head_sha` moves |
| Actions runs | Each upstream run ingested once as signed **evidence** |
| Someone approves | A **review** that satisfies a `one_approval` requirement |
| Click **Merge** | The merge recorded against the proposal, with the base sha `adp undo` needs |

A commit message trailer binds the intent explicitly:

```
ADP-Intent: #92
```

The shadow proposal **adopts GitHub's pull request number**, so `gh pr view 482` means one thing on
both planes. It is an ordinary `proposals` row on purpose: `evaluateLandPolicy`, `undo` and the
evidence bundle are each already written against a proposal, and companion mode's whole claim is
that a change arriving through GitHub is not a second class of change.

### Two checks appear on the pull request

Everything above is invisible to a developer who never leaves GitHub, so it is published where
GitHub already looks.

**`ADP / change record`** — never a verdict. `success` says a signed change record exists for the
commit; `neutral` says none does yet. Both pass if somebody marks it required, because the check
allowed to block is the other one. A commit bound to no intent **says so** rather than having the
line omitted, since that is the state the whole product is about noticing. It reports a model
observed in the trajectory as *observed* and one that only the token claimed as *asserted*.

**`ADP / policy`** — the land policy's verdict, `failure` when a requirement is unmet and `success`
when none is. Each unmet requirement keeps its remedy and the literal command that fixes it, because
a check run is where most people meet an ADP refusal for the first time.

This is the resolution of the seam, and it is worth stating plainly: **ADP does not take the merge
button away.** It publishes a verdict GitHub already knows how to require. Make `ADP / policy` a
required check in branch protection and GitHub will not merge until ADP agrees — because the
repository owner required it, not because ADP intercepted anything.

Both checks are *updated* rather than appended: GitHub keeps every check run of a given name and
shows the newest, so appending leaves a pile of stale rows to scroll past. A check run is a current
statement about a commit, and there is one of it. They republish whenever their inputs move — the
pull request changing, a push, an upstream CI result, an approval arriving.

---

## 3. What it refuses to do

The refusals are the design, not gaps. Each one is a place where doing the obliging thing would make
the record wrong.

**A repository that ingests refuses natively created proposals.** `proposals` is unique on
`(repo_id, number)` and the shadow proposal adopts the upstream number, so a native create would
collide. Both create paths refuse with a 409 naming what to do instead — both, because `gh pr create`
goes through GraphQL and a guard on `/api/v3` alone is one the incumbent client walks straight past.
A proposal that predates the mirror keeps its number; ingest declines to overwrite it.

**The same applies to natively created issues,** for the same reason and with the same 409.

**`adp land` refuses an ingested proposal.** A shadow proposal is an ordinary row precisely so
`evaluateLandPolicy` and `undo` can take it — which also makes it one `land` could merge. It must
not: the branch lives on GitHub, the merge button is what a companion-mode developer uses, and two
writers against one branch is the failure mirror mode exists to avoid. `land` refuses *before*
evaluating the policy, so a proposal that would have satisfied it is refused for this reason rather
than sliding into a merge. **An ingested proposal is evaluable and not landable.**

**`adp undo` refuses rather than guessing a base.** The pre-merge base sha is not in GitHub's
webhook payload. `undo` resolves it from the merge commit's first parent, from a base ref that does
not yet contain the merge, or from the mirror's own sync log — in that order — and returns
`merge_base_unknown` when none of the three answers. A guessed base makes `undo` *succeed* and
remove the wrong range.

**An instance on the personal-access-token path publishes no check runs, and says why.** GitHub's
Checks API refuses personal access tokens outright, so the App is not a nicety. The PAT path still
ingests.

**A failed check-run write never fails the ingest that preceded it.** The record is the product; the
check run is a view of it.

---

## 4. What it costs

| | |
|---|---|
| **Your workflow** | Unchanged. Same remote, same pull requests, same reviewers, same merge button |
| **Your repository** | Stays on GitHub. `git clone` keeps working throughout |
| **New files in the repo** | One, `adp.yaml`, and `adp init` shows it to you before you commit it |
| **Given up** | Creating proposals and issues natively on that repository, and `adp land` |
| **Credentials** | A GitHub App installed in your own organisation, or a personal access token for the ingest-only subset |
| **Infrastructure** | An ADP instance. `make local` is enough to evaluate; [`self-hosting.md`](self-hosting.md) is the real thing |

The record is not stuck on the instance that made it. A repository's record moves with
`GET .../export` and `POST .../import`, signatures intact — see
[`self-hosting.md`](self-hosting.md).

---

## 5. Where to look next

| | |
|---|---|
| [`README.md`](../README.md) | The CLI reference, the REST and native planes, and `make demo` for native mode |
| [`self-hosting.md`](self-hosting.md) | Running the instance this points at |
| [`api-compatibility.md`](api-compatibility.md) | What `upstream_number` and `upstream_url` mean on the wire, and what a contract bump promises |
| [`../CHANGELOG.md`](../CHANGELOG.md) | Every item above, with the reasoning that produced it |
