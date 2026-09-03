# Changelog

The rule a version carries: the git tag, the GitHub release, the published
image (`ghcr.io/deduva/adp`), the Helm chart's `appVersion`, the workspace
package manifests, `spec/openapi.yaml`, the newest entry in this file, and the
served `ADP-API-Version` all move together — `vX.Y.Z` tags a commit whose
`server/src/api-version.ts` says `X.Y.Z`. `scripts/dev/check-release.sh`
asserts every one of those on each push, and the release workflow re-runs it
before publishing an image. What a bump promises is defined in
[`docs/api-compatibility.md`](docs/api-compatibility.md); whether the operation
set moved with the version is enforced by `spec/operations.snapshot.json` and
its spec-coverage guard.

Until 2026-08-23 only one edge of that rule was enforced, and it was checked on
the tag push — after publication. Two contract bumps slipped through it.

## v0.7.0 — unreleased

**Companion mode: ADP underneath GitHub.** A product review on 2026-09-02 walked `main` as a
GitHub developer rather than as an evaluator and landed on a seam the backlog had not named: the
more faithfully a developer keeps GitHub as their workflow, the less of ADP's most interesting
behaviour is authoritative. Mirror inbound handled two events — `push` and `workflow_run` — so a
repository whose issues, pull requests, reviews and merges all live on GitHub handed ADP a stream
of commits and CI verdicts and nothing that said what any of it was *for*. This release is mostly
ingest, and what it buys is that land policy, `adp undo` and the evidence bundle all reach a
change that arrived through GitHub. `PLAN.md` Phase 5 is the backlog; entries land here per item.

### A GitHub pull request is a proposal in ADP (#224)

`pull_request` deliveries — `opened`, `reopened`, `synchronize`, `edited`, `closed` — become a
**shadow proposal**: an ordinary `proposals` row carrying the upstream number and URL. Opening a
pull request on a mirrored GitHub repository now produces one with no ADP command run;
synchronising the branch moves `head_sha`; closing it without merging closes the proposal.

It is an ordinary row on purpose. `evaluateLandPolicy`, `undo` and the evidence bundle are each
already written against a proposal, so a parallel "external pull request" type would have meant
reimplementing all three against a second shape — and companion mode's whole claim is that a change
arriving through GitHub is not a second class of change.

**The shadow proposal adopts the upstream number**, which is 5a's first open decision, settled. It
keeps `gh pr view 482` meaning one thing on both planes, and it costs the repository the ability to
create proposals natively while ingest is on: `proposals` is unique on `(repo_id, number)`, so both
create paths now refuse with a 409 that names what to do instead. Both, because `gh pr create` goes
through GraphQL and a guard on `/api/v3` alone is a guard the incumbent client walks straight past.
A proposal that predates the mirror keeps its number — ingest declines to overwrite it rather than
destroying a record to make room for a mirror of one.

Idempotency is a partial unique index on `(repo_id, upstream_number)` and a "nothing moved" check,
not a delivery id: GitHub redelivers routinely, and it also sends `edited` for a label change and
`synchronize` for a force-push that resolves to the same sha. All three mean the row is already
right, and none of them may append to an append-only log.

What this deliberately does *not* do is write `proposal.merge` for a merged pull request. The row
records the merge truthfully, but that verb carries the before/after base sha `undo.ts` reads and
the webhook payload does not contain it — recording one without it would make `adp undo` refuse for
the wrong reason. That is #225, and the test asserts the gap rather than leaving it to be found.

On the wire: `upstream_number` and `upstream_url` on the proposal representation, null on a
natively created one. Additive — no existing field moves.

### `adp undo` reaches a merge that happened on GitHub (#225)

A pull request merged upstream now writes a real `proposal.merge` operation, which is the verb
`undo.ts` resolves — so the one verb most worth having in the mode we tell people to adopt is no
longer the one that mode cannot reach.

**Most of the work is one value GitHub does not send.** Undo reads three things off the operation:
the branch, where it ended up, and where it was. The first two are in the payload. The third is
what the compensating revert actually computes against, and a guessed one would make undo run,
succeed, and take out the wrong range — worse than the refusal this item exists to remove. So it is
established as a fact or not at all, from three sources in order of how directly each one knows:

- **the merge commit's first parent**, when it has two or more — true by construction, and what
  GitHub's default merge button produces;
- **the base ref here**, when it does not yet contain the merge — the `pull_request` and `push`
  deliveries race, and this is the ordering where the answer can simply be read;
- **`mirror_sync_log`**, when the push already landed — our own record of where the ref went, so
  the row before the newest one is where it was.

When none of them can answer — a squash or rebase whose push arrived first — nothing is recorded
and the response says `merge_base_unknown`. A rebase of *n* commits leaves the pre-merge tip at
`merge~n` and a squash leaves it at `merge~1`, and nothing in the payload distinguishes them. Undo
then refuses because there is no merge recorded, which is true, rather than because a recorded one
is unusable.

The merge record is written **independently of the row update and is idempotent on its own**, so a
redelivery arriving once the base branch has caught up can complete a record the first delivery
could not. `mergeMethod` is `upstream`: GitHub does not report which of its three buttons was
pressed, and the operation does not claim to know.

### A GitHub issue is an intent, and a commit trailer naming it binds (#226)

`intents.source` distinguished `issue` from `api` and stopped there, so a team organising its work
in GitHub Issues got an ADP intent universe *beside* theirs rather than under it — nothing could
join the two except by comparing titles. An intent ingested from an `issues` delivery now records
`upstream_host`, `upstream_number` and `upstream_url`.

**The host is its own column rather than something parsed back out of the URL**, because it is the
identity half and the URL is a display string: a proxy, an enterprise hostname change or a
repository transfer all rewrite the second and none of them change the first. 5-16 has to carry an
intent to another instance intact, and "issue 92" means nothing without saying whose 92.

**Two rows are written, exactly as the native path writes two.** The issue row is not bookkeeping:
`resolveTrailers` binds `ADP-Intent: #92` by looking up issue 92 in the repository and taking its
intent, and in companion mode #92 is a GitHub issue number — the only number the developer has ever
seen. Without it the trailer they actually write resolves to nothing.

That makes 5a's exit criterion reachable end to end, and the test walks it with no ADP command in
it: a GitHub issue arrives by webhook, a plain `git push` carries a commit naming it, and the
evidence bundle names the issue **by title**. The bundle's `change.intent` grows an `upstream_url`
beside the `issue_number` #157 put there, because a number in a per-repo sequence is not something
a reader on another instance can navigate to.

Natively filed issues are refused on an ingesting repository, on the same numbering grounds as
#224's proposals. That incidentally closes a fidelity gap `schema.ts` records as deliberate: ADP
numbers issues and proposals from two independent sequences where GitHub shares one, and on an
ingesting repository both numbers come from upstream, which never issues the same one twice.

A pull request delivered over the `issues` event is skipped — upstream they are the same object,
here they are not, and ingesting one twice would give a single piece of work two intents.

### A change that arrived through GitHub is attributed to its author (#230)

Mirror inbound attributed everything it recorded to `mirror:github:<owner>/<name>` — every commit,
and every proposal and issue the two items above added. That is a statement about how the record
*arrived*, written into the field that says who made the change. Now a GitHub user resolves to a
real ADP identity, and the signed provenance names them.

**No new table.** `external_identities` is already `(issuer, subject)`-keyed and provider-generic —
it exists so that a deployment with two OIDC providers cannot collide two people onto one identity,
and a mirror host is another such provider. The issuer comes from the mirror's own remote URL, so
an instance mirroring GitHub Enterprise gets that hostname and the same login on two hosts stays two
people.

**The subject is the numeric user id wherever GitHub sends one**, because a login is renameable and
an id is not. The difficulty is that GitHub does not send one everywhere: a `push` payload names a
commit's author by `username` alone, while `pull_request`, `issues` and `pull_request_review` all
carry `user.id`. Keying on whichever happened to be present would give one person two identities the
first time they both pushed and opened a pull request — so a login-only sighting is keyed
`login:<login>` and **upgraded in place** the first time that person is seen with an id, and an
id-keyed row is found from a later login-only sighting through the principal it created.

Attribution is per commit, and deliberately partial. GitHub caps a push payload's commit array at
20, and a first mirror import walks history nothing was ever delivered for, so a commit the payload
does not name keeps falling back to the mirror identity — which remains the honest answer for one
whose author this instance has no way to know. A `Bot` account becomes an `agent` identity rather
than a human one.

This landed ahead of 5-4 because 5-4 cannot work without it: `one_approval` is author-independent by
construction (#121), so a proposal authored by the same system identity that ingests its approvals
is one nothing can ever approve.

### A GitHub approval satisfies `one_approval` (#227)

`pull_request_review` deliveries become `reviews` rows against the shadow proposal, so the policy
5c is about to publish stops refusing every mirrored pull request on a requirement GitHub has
already met — which is worse than not publishing one, because a developer who has done what the
policy asks and is told they have not stops believing the policy.

**Two things `one_approval` now gets right that it did not before**, both of which ingest turns
from a corner case into the ordinary shape of review on GitHub:

- **A reviewer's current verdict counts, not every verdict they have held.** Approve, the branch
  moves, ask for changes — the approval is no longer that reviewer's opinion, and GitHub has always
  counted it that way. A native reviewer could already produce this and the stale approval went on
  satisfying the requirement. `commented` is ignored rather than treated as a verdict, so a comment
  cannot displace the approval it was left beside.
- **A dismissed approval stops counting**, and the review is kept rather than deleted: an approval
  that was withdrawn is a different fact from one that was never given.

`reviews` gains `upstream_id` — GitHub redelivers, and a review has no natural key, since two
approvals from one person on one proposal is an ordinary sequence rather than a duplicate — and
`dismissed_at`. An ingested review carries **upstream's** submission time, not the time this
instance heard about it, because that ordering is what decides whose opinion is current and a
redelivery must not be able to change the answer.

A review whose payload names no user records nothing and says so, rather than falling back to the
mirror's system identity: that identity also authors ingested proposals, so the fallback would
write an approval that can never count.

### A plain `git push` no longer drops the harness that made the change (#229)

`AuthenticatedIdentity` has carried `harness`, `model` and `sessionId` since 1-1, and
`POST /changes` has always written all three. The push path wrote none of them — so every change
captured by the ambient path 1b exists to make the default was signed with a provenance block that
named no harness.

**The failure was silent, and that is the interesting part.** The block was present, signed, and
merely thinner, which is indistinguishable from a human pushing without a harness. Nothing could
have caught it except a check that knows the two routes are supposed to agree, so the invariant is
now written into `AGENTS.md` and asserted by comparing the two blocks rather than by checking a
shape: **how a change arrived must not determine the quality of its provenance.**

The tuple travels as three environment variables set alongside `REMOTE_USER`, inherited by
`receive-pack` and the hooks it spawns, and read by the hook script into its post-receive body.
The hook route accepts them as nullish, because a bare repository created before this still runs
its old hook script and a required field would turn that into a rejected recording on every push.

Absent stays absent: a push from a token with no harness claims none. And where a commit carries
an `ADP-Session` trailer, the trailer wins over the token — the token says which session did the
*push*, the trailer says which session produced *this commit*, and they differ whenever one push
carries work from two sittings.

### Companion mode runs on a laptop (#228)

`adp init` configured the mirror and then printed a webhook URL and a secret for a human to paste
into GitHub's settings. Until that was done by hand, inbound ingested nothing — the mode was
configured, reported success, and recorded only what an outbound push already knew. A developer
without a publicly reachable hostname could not do it at all, which is most people evaluating this
on the machine they already have.

**So the poller is not a degraded substitute for the webhook.** It is the version of companion mode
that runs on a laptop, and it is on by default: making the mode that needs no public hostname the
one you have to know to ask for would be exactly backwards. `MIRROR_INBOUND_POLL_INTERVAL_MS=0`
turns it off on an instance that has a public URL and would rather spend the API calls elsewhere.

**It produces the same record, not a similar one**, and that is a structural property rather than a
promise: every fact goes through the function the webhook calls. Branch syncing was extracted to
`core/mirror-inbound.ts` for exactly this reason — two copies of the divergence handling, the
compare-and-swap and the sync-log accounting would have agreed on the day they were written and
not for long after. Running the poller beside a configured webhook is therefore safe rather than
merely unlikely to collide, since each ingest was already idempotent because GitHub redelivers.

Two behaviours worth knowing:

- **The cursor is the time the poll *started*.** Writing "now" at the end would open a window the
  width of the poll, in which an update that landed while it ran is newer than the cursor and is
  never looked at again. A poll that failed does not advance it at all, because the work in the
  window it never read would otherwise be invisible forever.
- **A failure in one section does not abandon the rest.** One repository with an expired credential
  must not stop every other repository from syncing; errors are collected per mirror and reported.

Commit attribution on this path is better than the webhook's: GitHub's commits API carries numeric
user ids where a push payload names an author by login alone, so a login-keyed identity created by
a webhook is upgraded the first time a poll sees the same person.

`adp init` no longer presents the webhook as a prerequisite, because it is not one any more.

### Which model produced a change is observed, not asserted (#231)

`provenance.model` came from the token, which took it from whatever `adp connect` or the mint call
said **once**, at connect time. A harness can change model inside a single run, and
`session_events.model` has recorded it per event since the trajectory slice landed — because that
was anticipated. So the field ADP published as "which model produced this" was an assertion, while
the observation sat in the trajectory unread.

That matters beyond tidiness: 2-4 (#176) prices an approval by the model and harness that produced
the change, and pricing a separation-of-judgment control on a self-asserted string is the same
category error 2-4 exists to correct one level down. `core/observed-model.ts` is what it can now be
written against.

**Both facts are reported, with a label saying which is load bearing.** A change is signed at push
time and the trajectory arrives out of band, so signing an observation not yet made is not
available — and the assertion is a real, weaker fact rather than a lie. The evidence bundle's
`produced_by.models` carries `observed`, `asserted` and `source`:

- `observed` is an **array**, in first-seen order. A run whose model changed is a different
  historical fact from one that used a single model, and collapsing it to "the last" or "the most
  common" would erase exactly the case #176 has to be able to price.
- `source: "asserted"` is the documented degraded mode — a harness with no reader — said out loud.
  The supervision UI renders it as *asserted by the harness at connect time*, and flags the case
  where the trajectory disagrees with what the token claimed.

The observation reads the typed `model` column rather than anything in the payload, so it survives
#161's retention: an aged-out event keeps every typed column and loses only its payload body, and
the observation outlives the transcript it was made from.

### The instance creates its own GitHub App (#232)

Setting up companion mode cost a personal access token and a webhook created by hand in GitHub's
settings, using a URL `adp init` prints as `<your ADP public URL>/…` because it does not know it.
Three manual steps and one secret before anything worked — and a PAT is the wrong credential shape
regardless: it carries the developer's whole account scope, it expires on their schedule rather than
the installation's, and revoking it breaks unrelated things.

**It also cannot do what the next two items need.** GitHub's Checks API refuses personal access
tokens outright, so `ADP / change record` and `ADP / policy` are unreachable from one however it is
scoped. That is why this landed first.

**The manifest flow matters more than the App does.** GitHub creates the App in the *user's own*
organisation, from a manifest this instance serves, and hands the credentials back to whoever served
it — so a self-hosted deployment gets one-click installation with no hosted control plane in the
middle holding everyone's keys. `GET /github-app/new` is HTML rather than an API because a browser
form POST is the only thing GitHub accepts a manifest as; the spec-coverage exemption says so.

Everything the conversion returns is stored encrypted with the same key and mechanism as mirror
credentials, and no read route serves any of it back — the private key can mint an installation
token for every repository the App is installed on. Installation tokens are minted on demand and
cached in process rather than written down: a credential with a one-hour life that is persisted
becomes a thing that has to be cleaned up.

The manifest asks for exactly the permissions items in this phase use, and no more — an installation
prompt is read by the person deciding whether to trust this, and a permission with no caller is a
request that cannot be justified when they ask. `pull_requests` is **read**, because 5a settled that
GitHub stays the merge authority.

The App's single endpoint delivers every installation's events, so unlike the per-repository webhook
it has to find its way back from `repository.full_name` — and it delivers to **every** ADP repository
mirroring that upstream, because nothing stops two of them and picking one would make which gets the
record an arbitrary function of insertion order. What the dispatch then *does* moved into
`core/github-event-dispatch.ts`, shared with the per-repository receiver for the reason #228 shares
branch syncing with the poller: inbound now has three arrivals and they must produce one record.

Uninstalling marks the installation gone and keeps the row. "Clean" means ADP stops receiving
events, not that the record of what it ingested while installed disappears.

The PAT path still works, and 5-5's poller is still necessary either way: an App also delivers to a
reachable URL, and a laptop has none.

### `ADP / change record` appears on the pull request (#233)

Everything this phase built was invisible to a developer who never leaves GitHub: the intent the
change is bound to, the trajectory that produced it, the model that ran, the signed evidence behind
each verdict. A check run is where GitHub already looks.

**It is never a verdict.** `success` says a signed change record exists for the commit and `neutral`
says none does yet; both pass if somebody marks the check required, because the check allowed to
block is #234's. A commit bound to no intent **says so** rather than having the line omitted — that
is the state the whole product is about noticing.

It carries #231's honesty onto the surface people actually read: a model observed in the trajectory
is reported as observed, and one that only the token claimed is labelled as asserted.

The check run on a commit is **updated, not appended**. GitHub keeps every check run of the same
name and shows the newest, so appending works and leaves a pile of stale rows a reader has to scroll
past to reach the one that is true — a check run is a *current* statement about a commit, and there
is one of it.

It republishes whenever its inputs move: the pull request changing, a push to its head branch, an
upstream CI result landing. The poller publishes them too, because an instance with no public
hostname is the one whose developer most needs ADP's answer to appear on the pull request — nothing
else about ADP is in front of them.

An instance still on the personal-access-token path publishes nothing and says why, and a failed
write never fails the ingest that preceded it: the record is the product and the check run is a view
of it.

### `ADP / policy` is a check GitHub can require (#234)

The land policy's verdict, published where branch protection can enforce it. **It is a check rather
than a merge gate of ADP's own, and that is the resolution of the seam this whole phase opens on:**
asking a developer to choose between GitHub's merge plane and ADP's is the choice mirror mode exists
to avoid, and publishing a verdict GitHub already knows how to require is the same enforcement with
none of the migration. GitHub will not merge until ADP agrees — because the repository owner made
the check required, not because ADP took the button away.

`failure` when a requirement is unmet, `success` when none is. Each unmet requirement keeps the
remedy and the literal command #145 gave it, because a check run is where most people will meet an
ADP refusal for the first time, and dropping the remedy to keep the summary short would undo exactly
what #145 bought. Advisories are reported either way: a quarantined gate that silently stops
mattering is worse than a flaky one.

It republishes when an approval arrives and not only on a push, since an approval is what
`one_approval` reads. And it is only honest at all because #227 landed first — before ingest carried
approvals it would have refused every mirrored pull request on a requirement GitHub had already met.

**5c's second open decision, settled: an ingested proposal is evaluable and not landable.** A shadow
proposal is an ordinary row precisely so `evaluateLandPolicy` and `undo` can take it, which also
makes it one `land` could merge. It must not — the branch lives on GitHub, GitHub's merge button is
what a companion-mode developer uses, and two writers against one branch is the failure mirror mode
exists to avoid. `land` now refuses a proposal carrying an upstream number, *before* evaluating the
policy, so a proposal that would have satisfied it is refused for this reason rather than passing
into a merge. The refusal names GitHub as the merge authority and this check run as how the verdict
acts.

### The CLI is on npm (#235)

`cli/package.json` was `"private": true` and the only documented install was a source build, so ADP
could not be obtained without cloning it — every front door this phase widened opened onto a
building with no road.

```bash
npx @deduva/adp --help
npm install -g @deduva/adp
```

No runtime dependencies, so an install is one download and no tree. The release workflow publishes
on tag with `--provenance`, which ties the tarball to the workflow run that built it — the same
claim the rest of this project is about, applied to its own artifact.

**It skips cleanly when `NPM_TOKEN` is not configured**, and says so, rather than failing the
release. A fork must still be able to cut a release that produces an image and a GitHub release: the
npm registry is one distribution channel among several, not a precondition for the others.

`cli/test/package.test.ts` asserts the package stays installable — not private, scoped `public`
(a scoped package defaults to restricted, which publishes successfully and is unreachable), `dist`
in `files`, a shebang on the entrypoint, and a build before every publish. That is a test rather
than a note because each of those failures is silent: the release stays green and nobody finds out
until a stranger tries to install it.

### `gh repo create` works (#196)

It failed on the **first** command of the first-contact journey, with a 404 that explained nothing:

```
$ gh repo create local/widget --private
HTTP 404: Route GET:/api/v3/users/local not found
```

`gh` resolves the owner before creating, to decide whether it is a user or an organisation, and then
creates through the GraphQL `createRepository` mutation using the node id that lookup returns. Both
halves are needed and neither alone closes it, which the issue had guessed and a probe against a
real `gh` confirmed.

`GET /api/v3/users/{owner}` answers **`Organization`** — the honest answer rather than a convenient
one, since ADP's owners *are* orgs (`repos.owner` is the org's immutable URL slug) and `gh` branches
on that field. It returns the organisation and never its membership: the route is owner-shaped, not
person-shaped, and must not become a way to enumerate principals.

The mutation is `createRepo` from the REST path, not a second implementation. Two would disagree
about the org row lock, the repo quota or the operations row inside a release — and the quota one is
the kind of disagreement that is only noticed when somebody escapes it.

**The bare `gh repo create <name>` form is refused**, naming the two-part form and where orgs come
from. It used to exit 0 and create nothing reachable, because the owner it derives is the token's
principal rather than an org; silence was the bug, and a refusal is the improvement.

The conformance suite runs it against real, unmodified `gh`, so the README's compatibility row is
enforced rather than asserted — that suite exists precisely because "gh works" is the kind of claim
that rots silently. Getting there needed `GH_HOST` **exported** rather than only assigned: every
other `gh` call in that file names the host inside `--repo`, so the variable had never had to be one
the child process could see, and the first attempt talked to api.github.com.

### A checkout records which repository it is (#238)

`adp init` added an `adp` remote and `adp connect` found the repository by looking for a remote whose
host matched the server. Those composed — and they composed **by coincidence**: a repository's
identity lived in mutable local git state, so renaming or removing a remote broke every subsequent
ADP command with an error about remotes rather than about configuration.

The identity is now written down at `init`, per clone, in the git directory — the same reasoning
`connect` uses for excluding its files: one developer's setup is not every contributor's business,
and a file there cannot be committed by accident. `--git-path` rather than `.git/`, so a worktree
gets its own answer.

**Companion mode adds no remote at all.** There is nothing to push to ADP in that mode: the
developer pushes to GitHub and ADP observes, so the remote was an artifact of a mode they are not
in. `init` leaves their remotes exactly as it found them, and the "Next" steps now name the push
they were going to make anyway — which is the sentence the previous version could not say, having
just added a second remote to push to. The remote is still added on the native path, where the
developer genuinely pushes to ADP.

The old inference survives as a **last resort**, so a checkout set up before this keeps working — and
when it answers, the answer is written down. A clone infers at most once and is immune to the remote
moving afterwards, which is asserted by renaming the remote out from under it mid-test.

The refusal changed too: it named remotes, which is a fact about git rather than about what the user
has to do. It names `adp init` now.

## v0.6.0 — 2026-09-02

**The first five minutes, walked from a clean clone.** A first-run evaluation on 2026-09-01 ran
every command the README, the published site and the tooling tell a new user to run, in that order,
against a fresh `git clone`. The product held up — the whole suite, 772 tests with zero skipped plus
conformance and acceptance, went green in 2m39s on the first attempt. The path to it did not.

**`make demo` failed eight seconds into a fresh clone.** `sh: 1: tsx: not found`, reported as
`demo failed: migrations failed` — naming neither the cause nor the remedy, on the one command the
README, the landing page and `make help` all point a visitor at. It never installed the server's
dependencies, and the CI job that exists to keep this path working ran `npm ci --prefix server`
immediately before it: the only caller of `make demo` that never walked a visitor's path was its
own gate. The install moved into the demo, that step came out of CI, and the failure this
repository already knew as `sh: 1: vitest: not found` is now closed at the front door too.

**The published site advertised contract 0.5.0 while the server served 0.6.0** — three mastheads
and one paragraph, deployed straight from the tree on every push to `main`. That was one defect
wearing three hats: `recorder` was stamped 0.5.0 in the release that is *about* the recorder, and
`deploy/docker-compose.yml` deployed `v0.3.0` under a comment promising the released image.
`check-release.sh` reported "consistent" through all three, because it watched four surfaces where
there were seven. It watches the site, the compose tag and the recorder now, and each new check was
tested by breaking the thing it guards.

**`make local` ended by telling you to run a command this project documents as unsupported.**
`gh repo create` resolves the owner through `GET /api/v3/users/{owner}` before it creates anything,
that route is not served, and the README's compatibility table has said so all along — so the last
line the script printed was a guaranteed 404, as the first thing anyone did with a new instance. It
prints `gh api -X POST /repos/{org} -f name=widget` now. It also advertised a supervision UI that
returned 404: `main.ts` decides whether to serve `/ui/*` once, at boot, from whether
`server/web/dist` exists, and `make deps` never built it. `make local` builds the UI when it is
missing, and says so plainly when it is not there rather than printing a dead link.

**`adp init` left a repository in a state `adp connect` refused.** #153 created the repo on the
server and added no git remote; #154 then declined with "no git remote points at <server>". The two
commands this release is about are meant to run back to back, and on the native path the second
could not follow the first — while `adp watch`, which `init` recommended next, truthfully answered
"no open pull request yet" about a repository nothing had ever been pushed to. `init` adds the
remote (`adp`, never over an existing name — repointing someone's `origin` is how an upstream gets
lost), names the push in its Next block, and says how git authenticates here, because
"Username for https://…" is not a question whose answer is obvious.

Its failure mode is answerable now too. With no `--repo`, `init` infers the owner from the *parent
directory name*, which is a reasonable default and was a terrible thing to fail on silently: it
reported `Not a member of this organization (HTTP 403)` and stopped, naming no organization, no
source for the name, and not the flag that overrides it. The house standard was already set twice —
`adp connect`'s refusal names both remedies, and the land-policy 422 names the command that
satisfies each unmet requirement.

**The README's promise about 404s held for one of the eleven families it lists.** "Unimplemented
REST endpoints return 404 with a body naming the ADP equivalent. A broken call that explains itself
costs an agent one turn" — kept by the Actions passthrough alone, while search, releases, users,
branch protection and the rest returned Fastify's stock body, which names nothing. The worst case
was `/users/{owner}`: the route whose absence breaks `gh repo create`, whose replacement the README
knows and whose 404 did not say it.

It is a **not-found handler and not a set of routes**, which is the only shape that could work here:
`spec-coverage.test.ts` fails when the server serves a route `spec/openapi.yaml` does not describe,
and it is right to — the spec is a published contract and a downstream consumer generates its client
from it. Eleven families of stubs would have meant eleven families of spec entries for endpoints
that do nothing, or a hole in the guard. A not-found handler serves no route, appears in no route
table, and changes no generated client. The rule for adding an entry is in the file: name the ADP
capability that replaces it, or do not add one.

**`adp-recorder` declared a `bin` that could not execute.** `dist/main.js` had no shebang, so the
symlink `npm link` and `npm i -g` create ran JavaScript as `sh` and hung with no output. Nothing had
caught it because nothing documented installing it — the README showed `node dist/index.js` once and
then wrote `adp …` and `adp-recorder …` about twenty times, with no bridge between the two. Both are
`npm link` now, said where the build is, and `cli/`, `runner/` and `recorder/` have README files
that point at the reference rather than copying it. The runner names how it is actually
started — `adp runner up --here` — because it declares no `bin` at all.

**Two blemishes at the demo's own ending.** The evidence bundle rendered `gates[0]`, and the bundle
is sorted newest-first with `sbom` generated at merge — so the closing artifact deterministically
showed the one gate the visitor had nothing to do with, and hid the `test` result whose absence
caused the 422 three steps earlier. It prints every gate now. And the handoff section printed
`$ adp-recorder wrap … -- claude --output-format stream-json` for a stream that is replayed from a
fixture; the recorder, the readers, the session lifecycle and the chain are all real, and the
comments in `demo.sh` were scrupulous about which is which, but comments are not what a visitor
reads and a `$` prompt is a claim. Both lines are labelled.

Smaller, and each a published claim that was not true: `make doctor` failed on a fresh clone over a
missing dependency tree rather than over either prerequisite it is advertised as checking (a warning
now — it is the one command that is only ever asked a question); the demo announced "a five-minute
test drive" for a run that takes well under one; `make local-status` rendered "not running" as a
bare `make: *** Error 1`; and `adp connect` ended by asking for a `.claude/settings.json` edit whose
shape it never showed.

Also cleared: `fast-uri` (high) and `hono` (moderate, via the MCP SDK) in the server's production
dependencies, both by a semver-compatible `npm audit fix`. The *critical* that `npm ci` prints in
every tree is `vitest`/`vite` and is dev-only. One production advisory is deliberately left:
`drizzle-orm` <0.45.2, GHSA-gpj5-g38j-94v9, whose fix is a breaking upgrade across nine minors of
the data layer. The exploit path is an identifier built from untrusted input, and this codebase
builds none — all seven `sql.raw` call sites take a compile-time literal, and every user-supplied
value on those paths is bound as a parameter. It is tracked in `PLAN.md` as 0-19 with that analysis,
so it is picked up on the merits rather than waved through on an advisory ID inside a release branch.

**`make demo` ends on the handoff: one task, two harnesses, one continuous signed
history (#160).** D2 is the capability that most distinguishes ADP from a forge with
signed commits, and the argument for it was entirely structural — the endpoints existed,
`resumed_from_session_id` was self-referencing so a chain across three harnesses was
walkable without a join table, and none of it had been shown working.

**Nothing calls `checkpoint` or `resume`.** Two streams go through `adp-recorder wrap`,
one shaped like Claude Code's `--output-format stream-json` and one like Codex's
`exec --json`, and `--continue` is the only instruction — it exists because no stream can
signal a handoff the other harness has never heard of. That is the ordering note #160
made and the reason it waited for #151: a demo driven by a script calling the API on the
harnesses' behalf is evidence that a script can call two endpoints, not evidence of
portability.

The first harness exits non-zero mid-task, which is what a handoff looks like from
outside, and #151 turns that into a **suspended** session with a checkpoint to resume
from rather than one that looks finished. The op log reads
`session.start → session.checkpoint → session.suspend → workspace.create → session.resume
→ session.checkpoint → session.close`.

**Both halves of "one continuous signed history" are checked, not claimed.** The lineage
is walked back from the session that finished the work, and every session in the chain is
verified per session — recomputed from the stored rows by that request — using the
session-scoped endpoint #152 added. These sessions belong to no run: a developer handing
work between their own harnesses is not an orchestrated fan-out, and until that endpoint
existed there was no way to verify them at all.

It lives in `make demo` rather than a script of its own, because that script's port
picking, process-group kill and log-line readiness checks each exist because something
failed in a way that cost a debugging session — and a third copy of them would reacquire
the same bugs.

**`adp init` — one command, against a repository that already exists (#153).** The
strongest brake on adoption was never scepticism about signed evidence; it is that moving
repositories is unthinkable. ADP already had the answer — mirror mode makes it additive to
a repo that stays on GitHub — and offered it as an operator feature reached through
`adp repo mirror` with a remote URL, a secret and a credential to assemble by hand.

Now: the org, the repo, the mirror, and an `adp.yaml` detected from what the repository
already says about itself. **Mirror is the default and it is detected rather than asked
for** — a checkout with an upstream gets mirrored, one without gets a native repository,
`--no-mirror` overrides. That is #153's open question 4, settled on the grounds it gave:
native mode asks a team to agree and mirror mode asks one developer to add a remote, and
evaluation happens at the second price and never at the first.

**Detect and write, don't prompt.** `adp.yaml` asks for the gate names, the runner image,
its setup and what each gate runs — and the lockfile and the scripts block have already
answered all four. Detection is right most of the time and a wrong default is a two-line
edit, where a prompt is a decision the user is least equipped to make on the day they know
least. So it writes, prints what it wrote, says to review it — and **does not commit it**,
because committing on somebody's behalf puts something in their history they did not read.

**It starts no runner, and says why in one line.** #153 asked for one; #155 has since
decided a process that mounts the Docker socket does not start without being told this is
the right host. The later decision wins — attaching a repository is not an instruction to
hand root over the machine.

**One command table, so the dispatcher and the usage text cannot drift.** #153 predicted
the CLI would earn a subcommand framework here. The half that is actually earned is this:
the failure a framework would prevent was never parsing, it was two hand-maintained lists
of the same commands. There is one now, `--help` renders it, and a test asserts every
entry is reachable and documented.

**Four verbs the native plane had no command for (#155).** `cli/` wrapped five REST
calls, and several of ADP's most distinctive capabilities had none — so the documented
way to reach them was an HTTP request assembled by hand, which is a strange thing to ask
of somebody evaluating a product whose argument is that the tools should already know.

**`adp watch`** is the command a person leaves open beside an agent: the proposal, its
gates, the runs against it, and the land verdict. **`adp undo <sha>`** takes the commit
`git log` shows rather than an operation id, finds the merge that produced it, and says
which of undo's two paths it took — printing, for a compensating revert, the sentence that
stops it being read as done: *nothing is undone yet, #9 has to satisfy the land policy
first*. That is #159's last done-when. **`adp bakeoff`** opens a candidate set and one
labelled run per harness and prints the comparison — every server piece existed and
nothing drove them. **`adp runner up`** refuses to start unless told this is the right
host, because the runner mounts a Docker socket and a mounted daemon socket is root on the
machine it is mounted from.

**Asking whether a change would land no longer means trying to land it.**
`GET /pulls/{n}?land=1` returns the verdict, and when it is no, every unmet requirement
with its remedy and the literal command that satisfies it (#145). Opt-in, because
evaluating the policy reads gate results, the org's policy repo out of git and flake
statistics — a cost `gh pr view` should not pay on a route it uses constantly. Additive on
an existing operation, so the contract version does not move.

**The canonical walkthrough reaches for `curl` nowhere.** Parts B and C of the manual test
plan — the agent's loop and the human's supervision — now use `adp gate report`,
`adp pr review` and `adp undo`, and `scripts/check-docs.sh` fails the build if a `curl`
returns to them. Part D is exempt *by name*: registering a webhook and posting a lockfile
diff for admission are operator surfaces with no CLI verb by design, and a check that
swallowed the whole file would stop meaning anything.

`adp pr review` is the fifth command and not one the issue names — one line of REST, added
because leaving it out would have meant the walkthrough still reached for `curl` for one
step, which is the whole thing being fixed.

**Trajectory payloads have a retention window (#161).** Ambient capture (#149) started
writing at a volume nobody had operated before, against an implicit promise of unbounded
retention that nothing was going to keep — and the first operator to notice would have
noticed as a disk alert. `PLAN.md` 3-6 is the real policy and waits on measurement; this
is what happens in the meantime, and it is built so that nothing has to be unwound.

**Reduce payloads, keep the chain.** Ninety days by default
(`TRAJECTORY_RETENTION_DAYS`, `server.trajectoryRetentionDays`), overridable per org,
where **null means "inherit" and 0 means "keep forever"** — an org that was never
configured and one that chose to keep everything are different states, and only the second
is spelled 0. An aged-out event keeps its sequence, its links, its hash and every typed
column; what goes is the payload body. A reduced run still verifies.

**And it says so, which is the third verification state 3-6 wanted a name for.**
`not_retained` on a verification result is how many events in a range could only be taken
as recorded rather than re-derived from their contents — reported as a count rather than
folded into `ok`, because it is not a failure but a weaker claim about part of the range.

**What that costs is stated rather than glossed.** For a reduced event the *typed columns*
stop being independently verifiable too, because the hash covering them covers the payload
as well and cannot be recomputed without it. A test asserts exactly that: an edit to a
reduced event's `tokens_out` is not caught, and the same edit on a retained event is. What
survives is the link, and any signed checkpoint head past the reduced region still pins the
prefix — so a wholesale rewrite is still caught, which is the strongest guarantee available
once a preimage is gone. #152's signed-head check turned out to be load-bearing for
retention, not only for verification.

**Upgrading an existing instance changes behaviour**, which is the honest cost of shipping
a default instead of an implicit forever. The window is generous for that reason, the
server logs which one it is at boot, each sweep records a `trajectory.reduce` operation so
a missing payload can be accounted for rather than merely missed, and the org console shows
what has been reduced and what is due next. Under #199's default
`trajectory.payloads: structure` a reduced event loses a shape whose strings were already
replaced by their byte counts; a repository on `payloads: full` is exactly the one whose
org should set a window of its own.

**The record is navigable in both directions (#157).** `getEvidenceBundle` has returned
the change with its `intent_id` since M1 and the intent's title since #189, and the
evidence view rendered neither — which is the exact point at which "when a change lands
wrong, I want to know what the agent was trying to do" was one click from being answered
and was not. The reader was holding the identifier of the thing they wanted with no way to
follow it.

Four edges, each a join over data that already existed. **Evidence → intent**, by issue
number and title rather than as a uuid. **Intent → the runs against it**, each pairing what
it produced with what it cost, on the issue that carries it. **Run → its commits**, off
`session_events.git_sha`. **Commit → the session that produced it**, and the run that
session belongs to.

**The second route to a session is the one that mattered.** #157 asks that the path work
for a commit recorded by a plain `git push`, not only for one recorded through the explicit
API — and a join over `session_events.git_sha` alone answers only for commits some recorder
happened to observe. A pushed commit carrying an `ADP-Session` trailer records the id in
the change's *provenance*, not as a trajectory event, so the bundle walks both routes. A
session known only from a trailer reports `seq: 0`, which is not a seq — they are 1-based —
and therefore says "no such event" rather than "the first one".

`produced_by` is **navigation, not evidence**: nothing in it is signed and none of it
changes what the bundle attests. The route is typed in the contract now (`EvidenceBundle`,
`ProducedBy`), which takes a second line off `spec-coverage.test.ts`'s response-schema debt
list.

Incidentally: the issue view rendered "opened by ·" with a gap where a name should be,
because the issue read routes serialize no author. It claims only what the API says now.

**The M3 surface has a reader (#156).** The supervision UI had six views and none of
them was a run, a session, a trajectory, a checkpoint or an eval — so the part of ADP
that has no GitHub analogue, and is the reason to run it, was reachable only by someone
willing to write an API client and paginate a 2,000-event trajectory by hand. A
trajectory is worth its write cost only if something consumes it, and the second consumer
has to be a person or the recording is an experiment rather than a product.

Four views: a **runs list** filterable by intent and status, showing the arm off the
signed labels beside what the run cost to produce it; **run detail** with its sessions,
its evals and its trajectory; the **trajectory** itself, filtered by kind and paged, with
every typed column rendered as the thing it is — tokens, cost in micro-USD, duration, tool
identity, verdict, commit; and **session lineage**, so a resume chain across harnesses is a
picture rather than a series of API calls.

**Verification stays two answers.** `chains_ok` says the events ADP holds were not edited;
`emitters_ok` says ADP was given all of them. A run can pass the first and fail the second,
and that combination is the more interesting half — so they are two tiles rather than one
tick, with the attestation as a third, and an untracked emitter reads as *unknown* rather
than as a failure. A chain verified from a signed checkpoint says so instead of presenting
the weaker answer as the strong one.

**It also found the limit of its own exit criterion, and says so on the page.** Under
#199's default `trajectory.payloads: structure` every string is replaced by its byte count
before the event is chained, so the record can say what an agent *did* and not what it
*said*. Rendering the `[adp:str bytes=N]` marker as content would be worse than rendering
nothing — it reads as something the agent uttered and is identical on every row — so the
preview falls through to the payload's shape, and one banner at the top of the trajectory
explains why and names the one line of `adp.yaml` that changes it.

**Payload rendering is a client decision, and that is not a violation of the invariant.**
Payloads are opaque to the *server*: nothing server-side branches on their contents, which
is what keeps the protocol harness-neutral. Guessing which key holds the human-readable
part is done in the browser, where nothing downstream depends on the guess and a wrong one
shows a slightly worse preview rather than corrupting a record.

The runs list is `/runs/compare` with no intent filter — the aggregates a list wants are
already computed there, server-side, in one request. It gains a `status` query parameter
(additive), applied before `limit` so the answer is "the most recent N runs in this state"
rather than "the runs in this state among the most recent N", which reads identically and
is a different question.

**Contract 0.6.0, additive.** One new operation:
`GET /api/adp/repos/{owner}/{repo}/sessions/{id}/verify` (#152). No existing
operation changes shape, so a client generated against 0.5.0 keeps working
untouched. Everything below this heading ships under it.

**Verification scoped to one session, and bounded to a window (#152).** The
run-level endpoint answers "is this run's evidence intact", which is the
question a reviewer asks — and it cannot cover either of the two cases this one
exists for. A session need not belong to a run: a developer checkpointing their
own work is a session, and requiring a run would have made the orchestrated case
the only verifiable one. And a session long enough to be worth bounding is a
session worth verifying in pieces, which needs a window: `from_seq` exclusive,
`to_seq` inclusive, matching `seq`'s own 1-based numbering.

`from=checkpoint` and an explicit window are refused in combination, and the
refusal is the point rather than an implementation limit. An anchor already
fixes where the window starts; letting a caller move it off a signed head is
precisely how you build a verifier that starts too late and misses the tampering
it exists to find.

**A window reports the third verification state.** `prefix: assumed` — the
window was linked to what the database stores at its start, so it claims the
window is internally consistent and claims nothing at all about what precedes
it. That is a useful thing to be able to ask, and it is not a substitute for
either of the other two, which is why it has its own name rather than a bare
`ok`. Signed heads falling inside a window are still checked: narrowing what you
recompute is not a reason to stop comparing it against what was signed.

**Undo survives the branch moving (#159).** Undo reverted a landed merge by winding
the base ref back with the same compare-and-swap the merge used, and refused if the
branch had moved since. The refusal was right — silently discarding what landed after
would be far worse — but it meant undo worked exactly until somebody else pushed, which
on an active repository is minutes. The honest total was: available for one verb,
briefly.

There is a second path now. When the ref has moved, undo produces the change that takes
the merge back out on top of whatever landed since, computed as the three-way merge a
revert actually is — `git merge-tree --write-tree` against the bare repository, so no
worktree is created and no ref moves while the result is still being decided on.

**The revert goes through the land policy, and that is the whole design rather than a
limitation.** A revert is a change, and an undo that bypassed the gate would be a hole in
the gate opened by the one verb most likely to be used in a hurry. So undo opens a
*proposal* on `adp/revert-<n>` and stops: `undo_path: revert` means "here is the change
that undoes it", not "it is undone", and the branch does not move until that proposal
satisfies the same policy as everything else. It also enqueues the revert's own gates from
its `adp.yaml`, because a proposal nothing will ever report a gate result for cannot land
under the default floor — a refusal wearing the shape of a fix.

**A conflicting revert is refused with the paths named.** A revert merged with conflict
markers left in it would be a second outage caused by fixing the first. Two more cases
refuse rather than guess: a branch whose history was rewritten out from under the record
no longer contains the merge to revert, and a merge already reverted by hand produces the
tree it started from, which would otherwise open an empty proposal nobody can review.

**The operation log keeps the two apart.** `proposal.merge.undo` for a rollback,
`proposal.merge.revert` for a revert, and `undo_path` on the response. These are different
facts about history — one means the change was never in the branch you are looking at, the
other means it was there and a second change took it back out — and a log that blurred
them would be a log you cannot reconstruct from.

The undo response is typed in the contract now (`UndoResult`, `UndoRefusal`, and the
`Operation` shape underneath), which takes a line off `spec-coverage.test.ts`'s
response-schema debt list. The operation stays the top-level object, so a client reading
only the operation fields keeps working.
**Verifying a trajectory costs a constant now, not a session (#152).**
`verifyChain` selected every event of a session into an array, and
`GET …/runs/{id}/verify` ran that over every session in the run at once, behind
a plain `repo:read` token — so the peak cost of one request was the number of
sessions multiplied by the size of the largest, and a caller sets both. It reads
in batches of 500 and fans out four sessions at a time. On a 200,000-event
session the peak drops from 132.3 MiB to 1.6 MiB; at 50,000 events, from 38.8
MiB to 0.4 MiB. `make measure-verify` reproduces both, and the emitter-contiguity
check moved into one aggregate rather than a row per event beside it.

**The endpoint that makes tamper-evidence falsifiable should be the last thing
to become unreliable at volume**, which is why this was worth doing before
anything else in 1c: ambient capture (#149) is what turns the worst case from a
fixture into a real multi-hour run, and the verification route is simultaneously
the most valuable thing in the native plane and the cheapest way to exhaust the
server.

**`?from=checkpoint` verifies from the newest signed head forward.** A
checkpoint already signs the chain head it reached, so verification can start
there instead of at the genesis — bounded by what has happened since rather than
by the age of the session. It is opt-in, and the result says what it covers:
`coverage` on the run, and per session `prefix`, `verified_from_seq`,
`verified_to_seq` and the `anchor` it started from. A reader who has to notice an
absent key to learn that a verification was partial will not notice it.

**Chasing that turned up a hole in the check it was meant to be a cheaper
version of.** Recomputing a chain from its genesis does not detect an edit made
*consistently*: rewrite an event, repair every hash after it, and the chain
verifies perfectly, because the genesis is derived from the session id and
nothing pins the middle. What pins it is a signature over a head the rewrite
would have had to change — which the checkpoints have held all along and nothing
read. Full verification now checks every signed head it passes, reported as
`attested_heads_checked`, so it catches the repaired edit as well as the careless
one. `full` is therefore the stronger answer and not merely the slower one, which
is the right way round for a default.

**What each coverage does and does not catch is a test, not a caveat.**
`server/test/e2e-verify-coverage.test.ts` tampers four ways and asserts both
answers each time: an edit after the anchor (both catch it, at the same seq), a
careless edit before it (only full), a rewrite that repaired its own hashes (both,
by different routes), and a deletion reaching back past the anchor (both). It also
asserts the one case neither catches — a truncation past the last signed head —
because an incremental verifier that starts too late is a verifier that misses
the tampering, and the boundary of the guarantee is worth pinning down rather
than describing.

**`adp connect <harness>` — one command, and then the harness records itself
(#154).** Connecting used to mean minting a token by hand, writing an MCP config
in the right format at the right path, knowing that `gh` reads
`GH_ENTERPRISE_TOKEN` rather than `GH_TOKEN` for a non-github.com host, and then
writing the trajectory integration yourself because none shipped. All of that is
knowledge a command should hold. `adp disconnect` takes it back out.

**And then it proves it worked.** A config written to the wrong path fails
silently and looks exactly like success, so the last thing connect does is open a
session with the credential it just wrote and close it again. That round trip
exercises the token, the server URL, the repository resolution and the scope —
and it earned its place immediately, by failing on its own first run: a token
minted under a fresh per-harness principal has membership in no org and therefore
access to nothing, and no REST route grants one. The token is minted under the
caller's own principal now, narrower than theirs — `repo:read` and `repo:write`,
never `admin` — and carrying the harness, which is also the more accurate claim:
#141 fixed the grain of these fields, and a per-harness credential held by a
developer is exactly "the Codex integration's token". The provenance on a signed
change then names both the person and the harness.

**Everything it writes is inside the repository**, because all three harnesses
take project-scoped configuration — Claude Code's `.mcp.json`, the `Project`
layer of Codex's config loader at `.codex/config.toml`, and Gemini CLI's
`.gemini/settings.json`. Nothing reaches into `$HOME`, so disconnecting cannot
leave an orphan somewhere nobody looks and two checkouts of two projects cannot
fight over one file. ADP owns one key inside each, never the file: connect
replaces its own entry rather than appending, which is what makes re-running
after a harness upgrade a repair instead of a duplicate, and disconnect deletes a
file ADP created from nothing rather than leaving `{}` behind.

**Those files hold a live token, so they are kept out of commits.** A harness
reads its MCP configuration from a file in the repository and that file has to
carry the credential — so connect writes one into the working tree, and the next
`git add -A` would publish it. The paths go into `.git/info/exclude`: per clone,
not committed, because a `.gitignore` entry is itself a commit and telling every
contributor about one developer's harness is not connect's business.

**The `prepare-commit-msg` hook is the client half #142 never had.** The server
has read an `ADP-Intent` trailer off a pushed commit since #142; writing one
stayed something a person or an agent had to remember, and the binding is worth
exactly what the remembering is. The hook fills it in from
`branch.<name>.adpIntent`, or from a leading issue number in the branch name —
this repository's own convention and most others'. It never overwrites a trailer
the author wrote, never touches a merge, squash, amend or template message, and
writes **nothing** on a branch that names no issue: a wrong intent binds a change
to work it did not do, which is worse than no binding and much harder to notice.
It uses `git interpret-trailers` rather than appending a line, so the trailer
lands in the trailer block instead of inside a paragraph where git would ignore
it.

**Recording attaches on whatever terms each harness allows.** Claude Code is the
only one that can start the recorder by itself — a `SessionStart` hook is handed
the transcript path, which is exactly what `adp-recorder tail` follows — so
connect writes that launcher. The others get a `wrap` launcher, which is the
honest answer where a harness offers no place to hook in, and a script in the
repository beats a paragraph in a README that has to be retyped correctly. The
MCP server is invoked as `node dist/mcp/server.js` where a build exists and via
the direct `tsx` binary otherwise — never `npx tsx`, whose cold start raced
Claude Code's MCP connect timeout often enough in this repository's own benchmark
harness to be worth avoiding rather than tuning around.

Gemini CLI connects on the same command and is honest about what it gets:
everything riding on `git` and the commit trailer, and no trajectory, because
#150 ships two readers and it is not one of them.

**The session lifecycle, driven by what the harness did (#151).** Starting,
checkpointing and closing a session were each a call somebody had to remember to
make mid-task — so sessions existed only when an agent had been prompted well
enough, checkpoints existed only when someone was thinking about checkpointing,
and every session that ended stayed `active` for ever. `adp-recorder` drives all
three now, from signals it already has.

**A session binds to its intent because HEAD says which one.** The commit
trailer #142 established already names the intent the work answers; the recorder
reads it rather than being told, and accepts both forms the trailer allows — a
UUID or an issue reference — because making someone learn which of the two the
session route takes is the same defect one layer down. `--intent` still wins
where it is given.

**Boundaries, not intervals.** A checkpoint on a timer is a DSSE signature over
opaque state every N seconds, most of them signing what the last one signed. Four
boundaries and no fifth: HEAD moved, the reader emitted a `handoff`, a quiet
stretch with work recorded in it, and the end of the stream — the last taken
whatever else is true, so an interrupted session has somewhere to resume from. A
checkpoint names a commit, so ADP has to hold it: one taken against unpushed work
is refused with a typed error, deferred to the next boundary, and reported rather
than swallowed.

**`closed` and `suspended` are different facts, and until now only one of them
could be produced.** `sessions.status` has had `suspended` since sessions existed
and nothing ever set it. `wrap` is the command that can tell — the harness exited
0 or it did not — and `tail` always suspends, because a follower is not in a
position to claim the session finished. The session is ended only once the spool
is drained: a closed session refuses appends, so ending one over undelivered
events would make the rest of the recording permanently undeliverable. Undrained,
the terminal state waits on disk and `adp-recorder flush` carries it out. The
outcome is written as `suspended` when the session opens and only ever upgraded,
so a recorder killed outright — which runs no shutdown code by definition — still
reports what happened to it.

**Lineage nobody assembled.** A stream whose harness session id this spool has
recorded before *is* a resume, so `claude --resume` and `codex resume` produce a
linked session with no `resume` call. `--continue` covers the cross-harness case
no stream can signal, picking up this machine's last suspended session in the
repository. A refused resume falls back to a fresh session and says so: ADP
declines a resume whose checkpoint it cannot verify, and an unlinked recording
beats no recording.

**A checkpoint whose state was not in `jsonb`'s key order was permanently
unresumable.** `checkpoints.state` is `jsonb`, which sorts object keys by length
then bytewise and hands back what it sorted; the digest inside the signed
checkpoint statement was taken over `JSON.stringify` of the caller's order. The
signature verified and the digest did not, so `resumeSession` refused — at resume
time, possibly in another harness hours later, which is exactly the moment the
code around it was written to avoid. Nobody had hit it because hand-written
checkpoint state is short and often already ordered; the recorder writes five keys
in the order a person would list them and it failed on the first attempt. The
digest is canonical now, sorted in jsonb's own ordering rather than a plain
lexicographic one — any other canonical order would still differ from what comes
back out of the column, and this one makes the fix free, since a checkpoint whose
digest verifies today has keys already in that order.

**`POST .../sessions/{id}/close` takes an optional `status`.** Additive: the field
defaults to the behaviour that existed before it, so a client generated against a
body-less close is untouched. A suspended session still accepts events, because it
is not over; it may later be closed, which is what `flush` finishing a dead
recorder's spool is; and a closed one may not be suspended, because closing is
terminal and quietly ignoring the request would report a fact recorded that was
not. The operation log says `session.suspend` rather than `session.close`.

**A second harness, and the interface that makes it one (#150).** `adp-recorder`
reads Codex now — `codex exec --json` — alongside Claude Code's `stream-json`.
Two, chosen for having a stable machine-readable event stream rather than for
being popular, which is the criterion that makes a reader something other than
a scraping project. `--harness codex` is the whole of the difference at the
command line.

**One reader is an implementation detail; two put the contract in a file.** A
reader is `read(line)`, `end()` and an optional `sessionFacts()`, documented in
`recorder/src/readers/index.ts`, and a reader for a harness ADP has never heard
of is loaded with `--reader ./my-reader.js` — nothing in the package changes to
run it. The module and what it returns are both checked at startup, because a
reader validated late fails as a session that recorded nothing, which is the
outcome the recorder exists to prevent.

**The two harnesses disagree in a way one of them could not have shown.** Claude
Code assembles a `tool_call` from a pair of lines — the invocation and its
result. Codex reports an item's life as `item.started`, any number of
`item.updated`, and `item.completed`, all under one id, and the reader emits on
the completion alone: emitting on the first *terminal* status instead would
double every command that reports `failed` and then completes, silently, on the
harness's schedule. That same rule disposes without a special case of the thing
Claude Code needed one for — Codex's running to-do list is re-emitted on every
change, like `thinking_tokens`, and collapses to the version that survived.
A declined command becomes `rejected`, the same status a denied Claude Code tool
call gets and for the same reason. Codex's shell tool records as `shell` rather
than as the command line it ran: whether that is the same tool as Claude Code's
`Bash` is a question for whoever reads the corpus, and answering it here would
mean the recorder inventing a cross-harness taxonomy and writing its guesses
into the permanent record. Codex reports no money, so `cost_micro_usd` stays
unset — absent and zero are different, and a corpus summing them would be wrong
in the direction that flatters us.

**An out-of-vocabulary event no longer costs the session.** `kind` is a stored
enum the server does branch on, an unknown one is a 422 at ingest, and a 422
quarantines the shipper — deliberately, since a discarded rejected batch would
manufacture the exact gap the spool prevents. That is an acceptable price for a
bug in this repository and an unacceptable one for a typo in a reader nobody
here wrote, so every event a reader produces is checked before it reaches the
spool. A bad one is not dropped and not silently repaired: it is relabelled
`custom`, the rejected values are named in `type`, and the payload and counts
arrive intact. The record says a reader emitted something outside the
vocabulary, which is the only way anyone finds out.

**`harness` is still a string the server never branches on**, and readers are
still clients — the same line `adapters/` holds for scanners. An unknown
`--harness` with no `--reader` is refused rather than defaulted, before the
session is created: recording one harness's stream through another's parser
succeeds, produces a trajectory of `custom` events, looks like a recording, and
is worthless — and it is found out days later, from the record being relied on.
The README now says which harnesses are covered and what an uncovered one still
gets, which is everything riding on `git` and the commit trailer and none of the
turn-level detail.

**Recording costs the agent nothing, measured rather than argued (#149).** The
last of three, and the one the design's central claim rests on. Arm 5 is paired:
the same task, model, tool boundary and ADP-via-`gh` fixture arm 2 uses, run
twice, differing only in whether the agent's invocation was wrapped in
`adp-recorder wrap`.

**20 pairs. Cost per trial $0.0752 with the recorder off and $0.0730 with it on
— a paired mean difference of −$0.0022, 95% CI [−$0.0073, +$0.0029].** The
interval contains zero and bounds any effect below a tenth of a trial's cost.
20/20 landed in each condition. Tokens in, tokens out, tool calls and wall clock
all come out the same way.

**And the recorder was actually recording**, which is the column that stops this
being a measurement of its absence: 20/20 recorded trials verified with
`chains_ok` and `emitters_ok` both true, over 1,100 events. A trial that attached
the recorder and captured nothing would have cost exactly the same and meant
nothing.

The claim was always structural — the recorder reads a stream the harness already
produces, so no token of it enters the context window — and this arm tests that
construction rather than establishing it. It is worth the spend because the
project has been wrong about its own bets before with a first-party number to
prove it: arm 2's first sitting measured the native plane at $0.1435/trial
against $0.0848 via `gh`, contradicting the bet the plane was built on.

**Two reader faults surfaced only against a real transcript.** A denied tool call
was being stored as an opaque `custom` event; it is a `tool_call` with status
`rejected` now, which is what ADP's status vocabulary has that value for, and in
the first session recorded there were twelve of them explaining exactly why a
trial had failed. And the harness emits a `thinking_tokens` telemetry tick
continuously — 138 of them against 21 real tool calls — each carrying a running
estimate the next supersedes; they are counted and summarised once at
end-of-stream rather than hash-chained one row each. Neither was reachable from
unit tests over synthetic input.

The shared ADP fixture arm 2 and arm 5 both need moved to
`bench/arms/lib/adp-fixture.mjs` rather than being copied — it could not be
imported from `three-way-cost.mjs`, which runs `main()` on import. The published
arm 2 report regenerates byte-identical from the same records, which is what
makes that a move rather than a rewrite.

**`adp-recorder` records a real session, out of band (#149).** The second of
three: the spool and the shipper landed with no harness knowledge at all, and
this is the part that gives them something to carry. `session_events` now has a
producer.

**Recording is out of band, and that is the thesis rather than an optimisation
of it.** Nothing here runs inside the agent's context window — the recorder is
a separate process reading a stream the harness was already producing, so the
only thing on the agent's path is a pipe. Arm 2 measured what the alternative
costs without even paying it: its MCP arm recorded *no* trajectory and still
cost $0.1435/trial against $0.0848 via `gh`, and that gap is protocol
round-trips. Per-event recording through an agent-visible tool is the one
workload that would multiply it.

**Three verbs.** `tail` follows a transcript the harness is writing — the
primary way to attach, because the harness needs no flag, no hook and no
knowledge that anything is watching. `wrap` runs the harness and tees its
stream, for when something does know where the session ends. `flush` finishes
spools a previous recorder left behind, which is what makes "survives its
shell" true rather than aspirational: undelivered events are indistinguishable
from events that never happened.

**Mapping is the recorder's job**, so the server goes on storing `harness` as a
string it never branches on. The first reader takes Claude Code's
`--output-format stream-json`, the same stream `bench/lib/transcript.mjs` has
parsed since arm 2. A tool call becomes **one** event assembled from the two
lines the harness emits for it — ADP has one `tool_call` kind carrying a status
and no field that would let two events point at each other, so emitting one per
line would double every tool-call count in the corpus and leave half of them
with no outcome. What that costs is stated rather than hidden: a call still in
flight when the stream ends is recorded with no status, and counted, so the
session says how many rather than leaving a reader to guess why some events
have no status.

**A session survives ADP being down at the moment it starts.** The spool is
keyed by a locally-generated handle rather than by the server's session id, so
recording begins immediately and `POST /sessions` is retried until it succeeds;
a sidecar beside each spool records the repository and the harness so a later
`flush` can finish a session this process never got an id for.

Two bugs worth recording, both found by tests rather than by users. A signal
handler that drained and then called `process.exit(0)` **raced the stream loop
it was ending** — the exit could win, taking the undelivered tail of the
session with it. A signal only asks to stop now; the drain happens once, on the
ordinary path. And the tail's poll interval was `unref`'d on the reasoning that
a poll loop should not hold a process open, which is exactly backwards when
following the file *is* the work: with nothing else pending, Node exited
immediately and the recorder recorded nothing while looking like a clean run.

`server/test/e2e-recorder.test.ts` drives the **built** CLI as a subprocess
against the real routes, which keeps `recorder/`'s no-`server/`-import boundary
from becoming mutual through the test door — and proves the artifact someone
actually runs, signal handling included. The issue's first three exit criteria
hold: a recorded session verifies with `chains_ok` and `emitters_ok` both true,
a killed recorder's spool is finished by a later `flush` with no duplicates,
and a session recorded against an unreachable ADP arrives whole when it
returns. The fourth is a bench arm against a real model and is deliberately not
faked.

**`adp-recorder`, the durable half (#149).** `session_events` has been a
well-built store with no producer: a fixed cross-harness kind vocabulary, typed
columns for model and tokens and cost, a hash chain, idempotent retry through
`client_event_id`, drop detection through `producer_seq` — and nothing in this
repository writing a single event to it. This is the first of three changes
that fix that, and it is the half that has to be right before a reader is worth
attaching: the guarantees, with no harness knowledge at all.

**Events reach the disk before they reach the network.** A reader hands an
event to the spool, it is numbered and appended, and only then does the shipper
try to deliver it. A process that dies between those two steps loses nothing;
the next one reads the file and carries on from the number it finds, because
`producer_seq` is a property of the file rather than of a process's memory. A
torn final line — what `kill -9` mid-write leaves — is discarded on recovery,
which is the one event that genuinely did not make it.

**The spool is append-only and the acknowledgement lives beside it.** Truncating
a file that is simultaneously being appended to is where corruption comes from,
so the events file only grows and the high-water mark the server has accepted is
a second tiny file written by rename. Compaction is a separate operation that a
crash can only lose, never corrupt.

**Four answers, four policies.** An accepted batch advances the mark to the
server's own `accepted_through`, never to the local count — the server is the
one that knows what it durably holds. A reported gap rewinds and replays from
the number the server names, which is safe because `client_event_id` makes the
overlap a duplicate rather than a second append. An unreachable server keeps
everything and backs off. A 422 **quarantines**: the events stay on disk, the
session is marked, and an operator is told which batch and why — because a
recorder that discarded a rejected batch to keep moving would manufacture
exactly the gap this exists to prevent, and would look like a clean run doing
it. A 403 from the org storage ceiling is retryable rather than quarantined,
being the one refusal that clears without anyone touching the recorder.

**Both loops are bounded, and one of them was found by a test.** `drain`
continues while batches succeed, so a server answering 201 without ever
advancing its mark would have the recorder re-sending the same batch at full
speed — a denial-of-service written by us and aimed at our own server. The first
test that modelled a server whose mark stood still hung for five seconds and
then failed. Progress is a precondition of continuing now, and the same guard
covers the other door: a replay instruction repeated unchanged is a loop rather
than an instruction.

**Backpressure degrades honestly.** Past its byte ceiling the spool refuses
events and *reports* the refusal rather than thinning the stream; once there is
room the gap is recorded as a `custom` / `recorder.overflow` event, so it is
covered by the hash chain and carries its own count. The numbering stays
contiguous across it, which is the difference between "the recorder dropped 412
events here" and a sequence with a hole nobody can explain.

`recorder/` is a pure HTTP client on `runner/`'s terms — no `server/` import, no
database credential, no signing key — and it needs only `repo:write`, the scope
a developer's own token already carries, so it runs as the developer rather
than as infrastructure. The harness reader and the CLI are the next change; the
paired cost measurement the issue asks for is the one after.

**A trajectory stores a payload's structure by default; full payloads are
opt-in per repository (#199).** #148 put the secret detector at this ingest
path, and that is a real reduction in blast radius — but a detector removes
what it *recognises*. This governs the larger surface: source no pattern
covers, customer data in a tool result, a prompt a human typed. Ambient capture
(#149) is what makes every connected session a producer of it, by default,
without anyone asking — so the default had to be decided before the recorder is
built against it. Decided now it is free, because nothing writes to these
tables yet; decided after #149 it is a migration and an apology, owed to
exactly the early adopters whose first trajectories were taken under the wrong
default.

**Structure means the shape, not a stub.** Under `trajectory.payloads:
structure` the stored payload keeps its objects, its arrays, its keys, its
numbers and booleans, and each string becomes `[adp:str bytes=N]` — the length
in UTF-8 bytes, which is the unit #146's ceilings already speak and the only
one a verifier that is not JavaScript reproduces. Everything that answers *what
did the agent do* is a typed column and is untouched: the kind, the tool name
in `type`, the outcome, the model, the token counts, the duration, the commit
sha, the handoff edge. A reader sees a `read_file` that returned 14 KB from
`$.output` and succeeded in 12 ms. They do not see the file.

**`payload_digest` is the commitment, and the chain covers it.** sha256 of the
canonical JSON of the payload as supplied, so a producer holding its own copy
can prove the record corresponds to it — "verified, payload not retained" as a
real verification state rather than a hole, which is the state retention
(`PLAN.md` 3-6) is built around. It joins `eventHash` on the terms `producerSeq`
and `redactions` set: omitted from the hash when null, so a `full`-mode event
and every row written before the column existed hash to exactly what they
always did. Null is therefore also the answer to "is this payload verbatim",
which is why there is no second column naming the mode.

One digest over the payload rather than one per string leaf, and that is a size
decision taken deliberately: a per-leaf sha256 costs ~89 bytes in place of each
string, so a payload of a few hundred short strings — a structured tool result,
a message array — would come out *larger* structured than whole. A default that
inflates the common case is not a default anyone keeps. What is lost is
leaf-level comparison, which nothing asks for yet.

**The asymmetry is the whole argument for making it the default**, rather than
any judgement about how much anyone should record. A repo widens to
`payloads: full` after reading what a trajectory holds; nobody unsends what
already arrived. A malformed `adp.yaml` needs no carve-out here — it leaves
this at `structure`, so failing closed and falling back to the default
coincide, which is the shape a default should have.

The projection runs **after** #148's redaction and before anything is chained.
After, because the digest has to name what `full` would have stored, and under
`on_secret: redact` that is the redacted text — a digest over the original
would be a durable commitment to the value #148 exists to keep out of this
table. The detector still runs and still records `redactions` under the
default, on a payload whose content is no longer kept: "a secret was in this
session" is a fact about the developer's environment they need to hear, and
that column is now the only place to hear it. #146's ceilings are re-checked on
the projected form, because "no stored event exceeds the ceiling" has to hold
unconditionally, and a payload built from thousands of very short strings is
the rare case where the projection is not the smaller one.

The walk itself is shared with #148 rather than written twice
(`core/json-leaves.ts`): two definitions of "where the strings are" would
drift, and the first payload shape one handled and the other did not would be a
silent hole in whichever was behind.

**Secret detection runs at the trajectory ingest path (#148).** ADP already
runs push protection at the wire: `pre-receive` computes the diff, ships the
text, and a regex-plus-entropy engine refuses the push naming the line and
pattern. That is the only in-tree detector by design, and it is well placed
for what it guards — **the diff**.

A trajectory is a different object. It records what the agent *read*: file
contents pulled into context, environment inspected, tool output returned,
prompts a human typed. A `.env` the agent opened and correctly decided not to
commit never appears in any diff and would appear verbatim in a `tool_call`
payload. Push protection cannot see it, because it was never pushed — and
under ambient capture (#149) the failure mode is durable, hash-chained, and
readable by anyone holding a `repo:read` token.

The same engine now runs at that second path, before anything is chained.
"Adapters, never scanners" is untouched: this is *where* the detector runs,
not a new detector.

**A redaction is recorded as a redaction.** The matched span is replaced by a
visible `[redacted:<pattern>]` marker — surgical, so what surrounded the
secret stays legible and the trajectory stays worth keeping — and the event
carries a `redactions` array of `{ path, pattern }` naming where and what
fired. Two facts rather than one: a reader should see that an event was
redacted without having to spot it in the text, and "which sessions hit the
detector" should not be a full-text search over every payload in the corpus.

**The chain commits to the redacted form.** Scanning happens before the hash,
never after, so what verifies is what is stored and a redaction cannot be
edited away afterwards. `redactions` joins the hash on exactly the terms
`producerSeq` set: the key is *omitted* when nothing fired, so every event
written before the column existed hashes to what it always did and
`verifyChain` does not report the whole corpus as tampered. The column is null
rather than `[]` for the same reason — an empty array is set.

**Per repository, `trajectory.on_secret` chooses `redact` (default) or
`refuse`.** The default is the decision, not a convenience: refusing loses the
trajectory, and a lost trajectory teaches a user to turn recording off — which
costs the record everything and costs the secret nothing, since it was already
on their disk. `refuse` is there for the deployment that would rather have the
gap, and is opt-in because only they can price that trade. A malformed
`adp.yaml` fails closed on *land* and deliberately does **not** fail closed
here: both modes remove the secret, so there is no safety to buy by refusing,
only a trajectory to lose. Failing closed is for a choice between enforced and
not enforced; this is a choice between two enforced outcomes.

**What this costs, stated plainly.** #146 kept the opaqueness invariant by
noting that measuring a size is not reading a value. This *does* read the
value — there is no way to detect a secret without looking at one. What is
preserved is the half that makes the protocol harness-neutral: nothing
branches on the payload's shape. The walker descends to the string leaves of
an arbitrary JSON value and scans each one, so a harness storing its own
format still needs no ADP change. Object keys are left alone: a key is
structure, and rewriting one would be indistinguishable from the harness
having written a different document.

The issue's related question — whether full payloads should be recorded by
default at all — is **filed as #199 rather than bundled here**. #148 governs
what a detector recognises; that governs what is stored when nothing is
detected, which is the larger surface and a different argument. It took #148's
place as the last thing blocking #149, and is the entry at the top of this
section.

**Trajectory payloads and checkpoint state are bounded (#146).**
`session_events.payload` and `checkpoints.state` are `z.unknown()` by design —
ADP never parses them, which is what makes the protocol harness-neutral rather
than harness-aware — and neither had a ceiling. The 2026-08-22 storage
analysis measured a mean of **833 B/event** across 1,930 real events and noted
that nothing prevented the **~85 KB/turn** the industry anchor suggests: a 20×
range with no upper bound. Harmless only because nothing writes to these tables
yet; the moment ambient capture (#149) ships, every connected session is a
producer and the first person to enjoy the feature is the first to fill their
own disk.

Three numbers, documented in `spec/openapi.yaml` so a producer can respect them
rather than discover them: **128 KiB per event payload** (~1.5× the industry
anchor, ~157× the measured mean), **1 MiB summed across a batch** (a full
1000-event batch at the measured mean is ~833 KB, so the realistic maximum fits
and the pathological one does not), and **1 MiB per checkpoint state** — the
batch allowance rather than the event one, because a checkpoint is a whole
harness's resumable state rather than one turn of it.

**Measuring a size is not reading a value**, so the opaqueness invariant holds:
nothing inspects the payload's shape, only what it will cost to store.

**Refused, never truncated, and never silently digested.** A truncated payload
that is still hash-chained is worse than a rejected one — it is a durable
record that looks complete — and for a checkpoint it would mean a DSSE
signature over a state the harness never wrote. The batch is refused *as a
batch*, before anything is chained, because `appendEvents` is all-or-nothing
and a refusal that let the earlier events through would leave a chain the
producer cannot reason about. Each refusal names the offending event by index
*and* by its `client_event_id`: an emitter retrying identifies its events by
id, not by position, and a refusal it cannot map back is one it cannot act on.

The issue asked which of drop / reject / digest-substitute to pin, since the
recorder will be built against the answer. **Reject.** The digest option
belongs to retention (`PLAN.md` 3-6), where "verified, payload not retained"
describes a payload that *was* accepted and later aged out; using the same
state for one that was never accepted would make the one honest third
verification state ambiguous exactly where it needs to be precise.

One thing this found: **Fastify's default 1 MiB body limit sat below the batch
ceiling**, so an oversized batch was already being refused — by the transport,
with a bare 413 naming nothing. That is precisely the "discover the limit
rather than respect it" failure the ceiling exists to remove, so the two ingest
routes raise their own limit to 2 MiB. The typed 422 is now what a producer
meets; the transport guard stays, an order of magnitude out, for anything
absurd.

With this, **every prerequisite of 1-7 is cleared** and `adp-recorder` (#149)
is unblocked.

**`operations` is indexed for the queries actually run against it (#147).**
The operation log is written in the same database transaction as every change
— a stated invariant — so it grows with everything else in the system. It
carried one index, on `repo_id` alone, while both of its readers filter *and
sort*. Every plan contained a `Sort` over the whole matching slice, and the
org audit export could not use the index at all.

Measured at 1M rows, reproducible with `make measure-ops`:

| Query | Before | After |
|---|---|---|
| history: repo + sort | 46.3 ms / 19353 blocks | **0.1 ms / 23** |
| history: repo + verb + sort | 48.5 ms / 19321 blocks | **2.2 ms / 1134** |
| history: repo + actor + since | 46.3 ms / 19321 blocks | **0.2 ms / 197** |
| export: the org's operations | 73.8 ms / 21367 blocks | **4.2 ms / 8211** |

Two indexes, `(repo_id, created_at DESC, id DESC)` and
`(org_id, created_at DESC, id DESC)`: the leading column is the always-present
predicate and the rest is the sort key, so each reader's filter and its
`ORDER BY` become one ordered walk that stops at `LIMIT`.

**The fix the issue proposed for the export does not work, and that is worth
recording.** It suggested restructuring `repo_id IN (…) OR org_id = …` into
two indexed reads unioned. Measured: 71.8 ms against 73.8 — no improvement,
because Postgres will not turn `repo_id = ANY(…)` into an *ordered* scan; one
index walk cannot yield rows for many leading-column values in sorted order,
so the planner falls back to a sequential scan and a sort of the whole table.

What works is a **LATERAL**, which gives each of the org's repos its own
`repo_id = <const>` walk that the new index serves directly and `LIMIT` stops
early — R+1 bounded reads, merged and re-limited.

**The faster answer was tried and reverted, and that is the more useful
finding.** Carrying `org_id` on every operation makes the export a single
indexed read: 17 blocks, against the LATERAL's 8211. It is also wrong here.
`operations.org_id` carries a foreign key, so filling it on every row makes
every operation insert take a `FOR KEY SHARE` lock on the org — *one row per
tenant*, on the write path of every push, merge and gate result. Against
`repos`, whose foreign key the same insert already locks, that is a lock-order
inversion: `e2e-candidate-fanout`'s 50-way workspace fan-out deadlocked on it
immediately, and would have gone on doing so in production under exactly the
concurrency this project is built for. The schema is unchanged, there is no
backfill, and the export still goes from 73.8 ms to 4.2.

**Deliberately two indexes and not four.** A third on `(repo_id, verb, …)`
measured 2.2 ms → 0.2 ms on the selective-verb history query — a real
improvement on an already-acceptable number, bought with permanent write
amplification on the hottest write path in the system. Recorded rather than
taken, so it can be revisited with the ingest numbers 3-5 (#195) produces
instead of re-argued.

**Both readers gained a keyset cursor**, the same idiom and the same
`ADP-Next-Cursor` header every other native-plane list uses. The sort key
gained `id` as a tie-break, which is the load-bearing half: operations written
in one transaction share a `created_at` to the microsecond, so paging on the
timestamp alone either repeats them or skips them. Both tests seed rows
sharing an instant and assert a full paged walk equals the unpaged one, with
no duplicates. On a `path`-filtered request the cursor marks the last
operation *examined* rather than the last returned — path matching happens
outside SQL, so a page can stop before the end of the rows it fetched, and
resuming from the last match would skip everything in between.

`server/scripts/measure-operations-plans.mjs` ships with it, behind
`make measure-ops`, so the numbers above are reproducible and the next person
to touch these indexes can re-run rather than re-argue. Its seeding is
deliberate in two ways the first attempt got wrong: repo, actor and verb are
assigned randomly rather than by modulo (which correlated them, so the
"selective verb" shape was measuring a query that could never match), and
verbs are skewed 90/10 toward one hot verb, because a uniform distribution
makes every filter look selective and flatters the index.

**Arm 2 re-run: the native plane's cost gap is gone at pilot scale.** The
benchmark's whole job is to gate our own investment, and its most
uncomfortable number was first-party: ADP-MCP at **$0.1435/trial** against
$0.0848 via `gh`, with *every* MCP trial costing more than *every* `gh` trial
— a clean separation, not a tendency. The leading hypothesis was that the
native plane had no tool to open a proposal, so an agent paid a
hand-assembled `curl` where `gh` spends one command. #144 added the four
tools. This is the re-run that tests it.

| | baseline (2026-08-10) | post-144-tools (2026-08-30) |
|---|---|---|
| ADP-MCP | $0.1435 | $0.0892 |
| ADP via `gh` | $0.0848 | $0.0771 |
| GitHub + `gh` | $0.0850 | $0.0710 |
| MCP : `gh` ratio | **1.69×** | **1.16×** |

**The hypothesis held.** But the honest statement is narrower than "the gap
closed", and the report computes rather than asserts it: in the baseline the
two ADP arms' per-trial cost ranges did not overlap at all, and now they do.
The residual 1.16× is a direction, not a separation — at four trials a cell
the arms are no longer distinguishable. That is weaker than a win and stronger
than nothing changed, and bounding what is left needs the study-scale
replication this report has always said it is not.

**The fallback was available and untouched.** `curl` stayed on the `adp-mcp`
tool list and unadvertised, and was used **zero times in twelve trials**. That
matters more than the cost figure: it means the residual is what the native
plane costs when its own tools are the ones being used, not an agent quietly
reaching past them. What is left looks structural — opening a candidate set
and resolving it are two MCP round trips with no single `gh` command standing
in for them, which no additional tool removes.

Every arm got cheaper between cohorts (`adp-gh` −9.1%, `github-gh` −16.5%),
which is why the ratio and not the absolute is the headline: cohorts ran on
different days and a vendor-side model change between them is invisible from
here.

**Run records are cohorted rather than pooled.** A second run dropped into the
old pile would have been averaged with the first, producing a mean describing
neither and destroying the only comparison the re-run exists to make. Records
carry a `cohort`; the report groups by it, never pools across it, and keeps the
earlier cohort rather than replacing it — a benchmark that overwrites its own
baseline cannot show that anything changed. Records without the field are the
original pilot.

Two setup differences are recorded on the report's own page rather than
smoothed over: the re-run instance ran today's default land-policy floor, so
`one_approval` was not actually enforced while the instructions still said it
was (enabling it was not an option — since #121 it is author-independent and
these arms are single-principal, so every ADP trial would have failed to land);
and the per-method `--allowedTools` list turns out to be a slightly leakier
boundary than it reads as. Neither moves the `adp-mcp`:`adp-gh` comparison,
because both ADP arms are affected identically.

**Arm 2 keeps its escape hatch, and records when the agent uses it.** #144
gave the native plane the four tools an agent needed and rewrote the `adp-mcp`
instructions to name them. It also pulled `Bash(curl *)` off that arm's tool
list, which the issue did not ask for and which was the wrong call twice over.

It makes the re-run a two-variable change: four tools appeared *and* an escape
hatch closed, so a cost drop could not be split between "the tools are
cheaper" and "the agent can no longer spend turns on HTTP it was told to
assemble". And a withdrawn hatch turns a step the tools still fail to cover
into a *failed trial* rather than an observation — which loses exactly the
finding worth having.

So `curl` is back on the list, and unadvertised: the instructions teach the
MCP path and never mention it. What makes that safe rather than sloppy is
that a fallback is now visible instead of invisible. Every trial records
`measurement.toolBreakdown` — per-tool counts, with Bash calls labelled by the
program they actually ran, so `Bash(git)` and `Bash(curl)` are different facts
— and `measurement.escapeHatchCalls`, a deliberately separate count of raw
HTTP invocations. Separate because it is the one signal the re-run has to read
at a glance, and burying it in a per-tool map would repeat the mistake of
burying it in a total.

The count is by *invocation*, not substring: a `curl` behind an `&&` counts,
`git log | grep curl` does not. It is a signal rather than a proof — an agent
holding `Bash(node *)` could reach HTTP through `node -e` unseen — which is
why the breakdown ships beside it instead of instead of it.

The published pilot records predate both fields, so the report says
**"fallback use is not measured in these trials"** rather than rendering a
zero. Those trials were *instructed* to use `curl`; a zero would be positively
wrong, and reading absence as zero is the same class of error as a skipped
test that exits green.

**The evidence bundle names the intent by title, and release 1a is complete
(#189).** `PLAN.md` 1a states its exit criterion as "a commit pushed by a
plain `git push`, from any harness, resolves to its intent, and the evidence
bundle names that intent **by title**". The first half shipped with #142 and
#143. The second did not: `getEvidenceBundle` returned `intent_id` and nothing
else about the intent, so a reader holding the artifact the whole product
points at could not answer "what was this change for" without a second round
trip against a route they had to already know existed.

This was nobody's issue. It is what was left standing when the six that 1a did
track — #141, #142, #143, #144, #145, #158 — all closed: the criterion the
section is measured by, which no item in it was about.

`change.intent` carries `{ id, title }` beside the `intent_id` that was
already there, so nothing generated against the old shape breaks. Title only,
deliberately: a bundle is read to answer why a line exists, and a title
answers that, while the body is the intent's own record and belongs behind its
own read rather than inflating every bundle for a question most readers are
not asking. It is `null` on an unbound change — an ordinary state, not an
error, and one the bundle now answers rather than leaving to inference. The
MCP `adp_evidence_get` tool inherits it for free, being a thin wrapper.

**Checked rather than asserted.** The acceptance walkthrough's B4 now pushes a
commit carrying an `ADP-Intent` trailer — plain `git push`, no ADP API call,
which is the whole point of the trailer — and C10 fails unless the bundle it
reads back names that intent by title. So the exit criterion for this release
is one assertion in the §2.1 walkthrough rather than a claim in a planning
document, which is the difference between a criterion and a hope.

**A persistent local instance, with a certificate `gh` will accept (#158).**
`gh` refuses plain HTTP for any host but github.com and no override exists, so
the GitHub-compatible plane — the whole point of the compat surface — could
not be exercised against a local instance without a real certificate. The
manual test plan called doing that by hand "the fiddliest part of the
walkthrough".

The machinery already existed, three times over: the acceptance suite,
the conformance run and `make demo` each mint a throwaway certificate and run
a proxy in front of the server, with port selection below the kernel's
ephemeral floor and log-line readiness rather than port probes — both of which
exist because something failed in a way that cost a debugging session. All
three were test fixtures. A person setting up an instance they could come back
to got none of it.

```bash
make local            # up, idempotent, prints how to reach it
make local-down       # stop, keep the data
make local-destroy    # stop and delete the data
```

It brings up Postgres on a named volume, the server from source, and the TLS
proxy, then prints the token, the URL, and the trust-store command for the
platform it is running on — per-tool (`SSL_CERT_FILE`, no root) and
machine-wide, including the extra import a browser on the Windows side of WSL
needs. `.adp-local/env` carries `GH_HOST`, `GH_ENTERPRISE_TOKEN` and
`SSL_CERT_FILE` ready to source, at mode 600 and gitignored.

**The demo/instance split is the point.** `make demo` is ephemeral by design
and correct to be; the gap was that a visitor who liked it had nowhere to go
but the Helm chart. This is the same server, the same proxy and the same
bootstrap with a longer lifetime, rather than a separate code path with
different affordances. Three things follow from "persistent" rather than being
decoration on it: the ports are fixed, because `PUBLIC_URL` is part of the
signed record rather than a display string; the certificate is good for 825
days rather than one; and **the signing key is minted once and kept**, because
it is what every signature in that instance's history verifies against and an
instance that rotated it per restart would silently orphan every change
already landed on it.

`deploy/docker-compose.local.yml` is a third compose file and the middle case
between the two that existed: a named volume and a fixed port, unlike the
ephemeral test stack, with no server image and no `restart:` policy, unlike
the production one. Its project name sits deliberately outside
`verify-clean.sh`'s `adp-test-*` sweep — it is not leaked state, it is state
someone asked to keep. `server/tls-proxy.mjs` moved out of `conformance/` for
the same reason: a supported mode must not depend on a file that lives in a
test tier.

**Not a production TLS story**, and `docs/self-hosting.md` §3b says where the
line is rather than blurring into it. Self-signed for `localhost`, because no
CA will ever issue for `localhost`; server from source under your own user; no
ingress, no backup, no second replica.

`scripts/dev/local-smoke.sh` drives all of it in CI on every push — up, `gh`
reaching it over TLS, a refused merge, a gate, a landed change, a stop, a
restart, and the evidence bundle read back from the restarted instance. The
restart is the assertion that matters: a supported mode nobody runs is a
supported mode that rots, and "the data is still there" is exactly the
property a script can lose silently.

**One thing this found:** `gh repo create` does not work against ADP and the
README said it did. It resolves the owner through `GET /api/v3/users/{owner}`
before creating, and that route is not served — which is why every harness
here creates repositories with `POST /api/v3/repos/{owner}` instead. The
compatibility table says so now.

**The native plane can open, review and merge a proposal (#144).**
`server/src/mcp/server.ts` registered 17 tools covering workspaces, the
operation log, undo, evidence, candidate sets, sessions, checkpoints,
trajectories, runs and evals — and nothing that opened, reviewed or merged a
proposal. An agent driving ADP through the native plane had to break out to a
raw `curl` mid-task, which the project's own benchmark instructions spelled
out at length. That is the leading hypothesis for the measurement that
contradicts our own bet: **ADP-MCP at $0.1435/trial against $0.0848 via `gh`
and $0.0850 on real GitHub** (arm 2, pilot scale, n=12). `gh pr create` is one
command; the native plane's equivalent was a hand-assembled HTTP request the
agent had to be told how to build, in a prompt, correctly, every time.

Four tools, thin wrappers over the REST routes that already exist — same
discipline as every tool beside them, no domain logic in the MCP layer:
`adp_proposal_open` (including `candidate_set_id`, so a candidate joins its
set at creation, the only moment it can), `adp_proposal_review`,
`adp_proposal_merge`, and `adp_intent_get`. The fourth is not on the issue's
list and is what its exit criterion actually needs:
`docs/api-compatibility.md` states plainly that the native plane is not
self-sufficient — nothing under `/api/adp` mints an intent, and an issue is
where one comes from — so closing the proposal loop while leaving that open
would have left the benchmark instructions carrying a `curl` regardless.

These wrap `/api/v3` rather than `/api/adp` because that is where the routes
are: a proposal *is* the GitHub-shaped object and an intent comes from an
issue, so a second native spelling of either would be a fidelity problem
rather than a feature.

**The refusal shape matters more here than anywhere else.** A refused land is
the one response an agent is guaranteed to see on a well-configured instance,
and an agent that cannot read it burns a turn guessing. `adp_proposal_merge`
returns the typed policy result intact — each unmet requirement with what is
missing and the command that satisfies it (#145) — rather than flattening it
to `message`, which says "Land policy not satisfied" and nothing actionable.
`adp_candidates_resolve` lands its winner through the same land path, so it
surfaces the refusal the same way now too.

`bench/arms/three-way-cost.mjs`'s `adp-mcp` instructions no longer contain a
`curl`: they name the four tools instead of teaching the agent to
hand-assemble HTTP. `Bash(curl *)` stays on that arm's tool list, unadvertised
— see the entry below on why an escape hatch that is available and *visible*
beats one that is absent. **The arm has not been re-run**: it is agent-backed, needs real tokens and a
real GitHub PAT, and runs out of band rather than in CI. Per this harness's
own contract an arm that was not run is reported as not run, so
`bench/report/three-way-cost.md` now says on its own page that its published
figure predates this fix and that the re-run's result will be published
whichever way it points.

**A refusal names the command that satisfies it (#145).** The refusal is the
product — `make demo` is built around reaching it, and the manual test plan
calls it out as worth doing deliberately: *"a policy that has never been seen
to refuse anything has not been tested."* Until now that moment produced a
typed `422` listing unmet requirements, which is correct and one step short:
the user was told `one_approval` was unmet and left to work out what to do
about it, which for a first-time user means going back to the documentation at
precisely the moment the product was about to prove itself. The repo already
has the opposite instinct elsewhere — an unimplemented REST endpoint 404s
*naming the ADP equivalent*, on the stated reasoning that "a broken call that
explains itself costs an agent one turn; a hang or a 500 costs it the
trajectory". This is that argument applied to the happy path.

Every unmet requirement now carries a remedy: what is missing, what to do, and
— where one exists — the literal command.

```
one_approval: no approving review → have a principal other than the author
  approve it — as that principal, run: gh pr review 1 --approve
gates_green: test not reported for b55529b → gates run on push — check a
  runner is up (`adp runner`), or report one: adp gate report --repo
  acme/widget --sha b55529b… --name test --status success
```

Three things the shape insists on. **One entry per gate**, not per
requirement, because that is the grain the command is written at — "some gate
is not green" is the sentence the user already had. **A gate nobody reported
and a gate that reported failure are different refusals**, fixed by different
things, where before both read "not green". And **no command is invented where
none exists**: a red gate carries a remedy sentence and no command, because
offering `adp gate report --status success` there would teach a first-time
user that the gate is a formality. The confidence bound is the same case.

It applies on **both merge paths**. REST and GraphQL are stated to enforce
identically, so they explain identically — and GraphQL is the path `gh pr
merge` takes, which is where most people will read a refusal at all, so a
remedy living only in the REST body would be invisible to exactly that
audience. The acceptance suite asserts the remedy text on both, including what
`gh` prints.

`unmet` keeps its shape, an array of strings, and each string now carries its
own remedy — error prose is explicitly not contract, and a caller that only
prints the line has the whole answer. `unmet_detail` is additive: the same
facts with the seams left in, for a caller that wants the command without
parsing a sentence.

**`make demo` shows the refusal rather than describing it**, through `gh pr
merge`, and asserts both remedies appear. Doing that surfaced a second defect:
the demo repo declared no gates, so `gates_green` was satisfied vacuously and
the refusal every line of its narration is about ("no gate has reported") was
really about the approval alone. The demo commits an `adp.yaml` naming its
gate now, so the beat it is built on is the one it actually performs.

**One `changes` row per sha, and a deterministic evidence read (#143).** Three
individually defensible facts were jointly a bug. `post-receive` auto-records a
signed change per new commit with a null intent (#142); `POST
/api/v3/repos/{owner}/{repo}/changes` — the documented way to record a change
*with* an intent — inserted unconditionally; and `changes` carried an ordinary
index on `(repo_id, git_sha)` rather than a unique constraint. So the
documented path to an intent-bound change, push then bind, left **two rows for
the same sha**: one auto-recorded and unbound, one explicit and bound. Then
`getEvidenceBundle` selected with no `ORDER BY` and no `LIMIT`, so which of the
two backed the evidence bundle — and therefore whether the bundle showed the
intent at all — was not pinned by the code. The index that made the lookup fast
made the plan likely to be stable in practice and no less unspecified.

`(repo_id, git_sha)` is unique now, and the route is an upsert: a call for a
sha the push already recorded *completes* that row, filling in `intent_id` and
`workspace_id` and **re-signing** — the signature covers `intent_id`, so a row
that gains a binding must gain a signature over the binding or the two
disagree. The provenance of an existing row is left as recorded: it names what
produced the commit, and this call is a binding, whose actor belongs in the
operation log — where the update is now recorded as `change.update`, with a
`before`, exactly as the create already was.

**Rebinding is refused, not performed.** A change whose intent moved would mean
the signed record said one thing yesterday and another today about the same
commit, verifiably both times, which is worse than having no signature at all.
Filling a null is not rebinding — it is the second half of a sequence that was
always meant to produce one record — so re-posting the same intent is a no-op
success, while a *different* non-null intent (or workspace) gets a typed `409`
naming what the sha is already bound to. `docs/api-compatibility.md` prices
tightened validation as a major bump; this is deliberately taken as a bug fix
instead, because the request it now refuses did not previously succeed at
anything — it produced two rows for one sha and an evidence bundle that chose
between them unordered. The status code for the working path does not move:
`201` on create and on completion alike, since flipping the documented
push-then-bind sequence to `200` to report an implementation detail of a fix is
the one part of this that *would* be a major break. `created_at` distinguishes
them for anyone who needs it.

The migration resolves existing duplicates rather than failing the deploy on
them — the opposite call from 0025's, and for a reason: there, duplicate repos
could have history hanging off both ids and choosing between them was an
operator decision, whereas here the duplicates are a known shape from a known
bug and the survivor rule is the one the fixed code applies. The bound row
wins, ties break oldest-first, and the one FK into the table
(`proposals.change_id`) is repointed at the survivor before the delete. It is
proven against a database that already holds duplicates: a throwaway database
migrated to the state before this migration, seeded with the exact shape the
bug produced, then migrated the rest of the way — running the migration that
ships rather than a transcription of it.

The push recorder gained `ON CONFLICT DO NOTHING` for the race its pre-flight
dedup cannot close. Two pushes carrying the same commit could both read "not
recorded"; before, that made a duplicate, and after the constraint it would
raise inside the one transaction covering the whole batch — discarding the
records for every other commit pushed alongside it.

**Token mint carries `harness`, `model` and `session_id`, so signed provenance
can name them (#141).** `README.md` promised provenance carrying "the pushing
identity, plus harness / model / session where supplied", and three of those
four were unreachable over HTTP. Everything else existed: the columns, the
`mintToken()` options, the `authenticate()` reader that puts them on the
identity, and the `provenanceOf()` that copies them into the signed block.
`POST /api/adp/tokens` accepted none of the three, and its only other caller —
`bootstrap.ts` — sets none, so every token in existence held null for all three
and every signed change omitted the fields that make its provenance worth
having.

The three are optional fields on the mint body now, echoed back in the response
so a caller can confirm what it was issued rather than minting blind — they are
unreadable afterwards except by using the token, and a typo in `harness` is
otherwise invisible until a signed change carries the wrong one. The
`token.mint` operation records them too, still without the token itself.

The grain question the fields raise is answered in the route rather than left
to the next reader: `model` on a *token* says which model the integration this
credential belongs to is built around — "this is the Codex integration's
token". It is not a claim about which model produced a particular attempt,
because a harness can switch models mid-session and the credential outlives the
switch. That claim is `runs.labels`, per attempt. Both, not either.

**Additive**: new optional request fields and new response fields, so a client
generated against 0.5.0 keeps working untouched. An e2e test drives the whole
chain — mint, authenticate, provenance, signature — and verifies the signature
over the provenance that names all three, because every field was already
present at every other step and a partial revert would otherwise type-check.

**A fresh instance floors at `gates_green` alone (#174).** `LAND_POLICY_FLOOR`
defaulted to `gates_green,one_approval`, and since #121 that second
requirement is author-independent — so the default handed a developer
evaluating ADP alone a refusal they structurally could not satisfy. They are
the only principal, and the requirement exists to constrain the person trying
to satisfy it. Because the three policy levels union, nothing below the
instance could drop it either: the only way out was an admin-owned env var
documented in one table row. GitHub's own default for a fresh repository is
zero required approvals, so this was stricter than the incumbent for exactly
the audience least able to absorb it.

The refusal that carries the argument is untouched — a merge is still refused
while the change has no gate result, which is the beat `make demo` is built
on. `one_approval` becomes opt-in: one env var for an instance, one line of
`adp.yaml` for a repo, one line of the org floor for a tenant. The
deployments that want it are the ones that have a second principal.

Nothing about `one_approval` itself changes. An instance that sets it gets
exactly the behaviour #121 shipped.

**Behavioral, and it loosens rather than tightens**, so no client breaks and
no contract moves. An instance that wants the old behaviour sets
`LAND_POLICY_FLOOR=gates_green,one_approval` — as `make demo`, the acceptance
walkthrough and the conformance run now all do explicitly, rather than
inheriting a default their assertions depend on. The Helm chart's
`server.landPolicyFloor` default moves with the code so there is one default
and not two.

**The published site argues past the merge, and a third page walks the loop.** `make site`
asserted that the site *rendered*; nothing asserted that it argued the right thing, and read
cold the front page claimed only that agents write code and ADP checks it — a claim every
merge-blocking review bot can make, ending where the field data says the trouble starts. The
front page now covers what the record is for after a change lands and why it has to survive a
change of harness, and `docs/html/sdlc/` is a new page mapping the six-stage loop the
published agentic-SDLC playbooks describe against what holds each committed artifact today.
The essay reaches past the merge too: section 01 now says that verification is where the
queue is visible and deployment is where the failures land, and the alternatives it weighs
gained the one that is a practice rather than a product — a playbook is what says an artifact
should be written down, and cannot be the thing that refuses when it wasn't.
No capability claim moved: the front page's status table is still the only place that is
maintained. `make site` and CI's `site-runtime` job now drive three pages rather than two, on
the same exit criteria, so the new page cannot be published ungated.

**`one_approval` is author-independent.** An approving review from the
principal that authored the proposal no longer satisfies it (#121). A merge
that was previously allowed on the author's own approval is now refused with
the usual `422` naming `one_approval`, and landing under this floor takes two
principals.

This is a **behavioral change without a contract bump**, and the distinction is
worth stating rather than assuming. No request or response shape moved, and a
client generated against `0.5.0` still works unmodified: it still calls merge,
and still reads `unmet` off a `422`. What changed is the meaning of a policy
requirement, and land-policy outcomes were already a function of instance, org
and repo configuration rather than of the contract version.

It can still break an existing workflow — specifically a single-principal one,
which is exactly the workflow it exists to break. ADP's own acceptance,
conformance and `make demo` runs were three of them: each opened a proposal and
approved it as the same actor, so each now mints a second principal to approve
with. Anything scripted the same way needs the same change.

GitHub refuses self-approval at review time; ADP records the review and refuses
the *merge*, because the requirement lives in the resolved land policy rather
than in the review route — so every level that can name `one_approval` (instance
floor, org floor, repo `adp.yaml`) inherits the check, and both merge paths
(REST and GraphQL) enforce it through the one `landProposal` sequence.

**One design system for the published site (#163, second half).** The two pages were
written months apart by different means and shared no styles: the palette was declared
twice and identically, the container widths disagreed at `940px` against `1120/760/520`,
and the vertical scale was thirteen unrelated numbers with an inline `style=` at the one
place it ran out. Neither page responded to a breakpoint, neither showed a focus ring, and
both tables were unreadable on a phone.

`docs/html/site.css` now owns the palette, a seven-step type ramp and an 8-base spacing
scale for both pages. Neither page declares a colour or a static inline `style=`; the
essay's simulations reach their colours through `var(--sim-*)` tokens instead of the 91
hex and `rgba()` literals that used to live in its JavaScript, so the whole site restyles
from one file.

The direction is **"Blueprint"**: cool paper under a faint 24px grid, structure drawn in
1px black, section boundaries banded and numbered, figures set as numbered plates. It was
chosen from four drawn against the same content — Paper (warm, serif, narrow measure),
Instrument (the dark page rebuilt), Blueprint, and Inversion (ink on paper with full-bleed
dark figure bands) — and it won on the specific complaint: the page had no visible section
boundary and no scale, and Blueprint's whole grammar is drawn structure, so it cannot
quietly lose them again. `docs/html/site.css` carries the shortlist and the reasoning.

What a reader gets: rhythm and gutters that move on three breakpoints, prose tables that
stack into labelled records below 620px, a core diagram that stacks rather than becoming a
640px horizontal scroller on a phone, 44px touch targets, and a visible focus ring on every
interactive element. Text colours were picked against the paper ground rather than by eye —
every one clears WCAG AA, with separate tokens for marks, which only need 3:1.

Two inline styles survive by design, and only in the essay: a width or an opacity a
simulation computes per frame is state, not styling, and cannot live in a stylesheet. Each
is required to carry a `{{ hole }}`, which the test asserts.

`make site` drives both published pages in the pinned Chromium and asserts #163's exit
criteria — no horizontal scroll at 320, 375, 768, 1024 and 1440px, every table readable at
375px, a focus ring on every interactive element, one stylesheet owning the palette, and
nothing off-origin but Google Fonts. CI runs it in the `site-runtime` job. The criteria
stopped being things anyone had to check by looking.

No contract change; nothing under `server/`, `cli/`, `runner/` or `spec/` moves.

**The published site can rebuild what it serves (#163, first half).** `docs/html/support.js`
is 69 KB of generated JavaScript whose own header named a `dc-runtime/` that was in no
repository anyone working here could reach. It drives every interaction in the essay at
`/why/`, and nobody could fix, upgrade, or even read the source of it. #138 saw this and
confined it to the secondary page rather than resolving it; the decision taken here is to
vendor.

`dc-runtime/` now holds the source. It was recovered from the artifact itself — an
unminified `esbuild` bundle that had kept its module markers, identifiers and comments —
and the recovery is verified the only way that means anything: a fresh build reproduces the
previously committed file byte for byte, but for the banner and two pairs of redundant
parentheses that `bun`'s printer keeps and `esbuild`'s drops. `make dc-runtime` and CI's
`site-runtime` job rebuild and assert, so a hand-edited artifact fails rather than ships.

**The site no longer loads code from a CDN.** The runtime fetched React, ReactDOM and
`@babel/standalone` from `unpkg.com` on every page load. Because it hides the raw template
before loading anything, an unreachable unpkg produced a blank page, not a degraded one —
and it put two packages on a published site that this repository did not contain. React and
ReactDOM are now vendored under `docs/html/vendor/` by the build, from the pinned
dependencies, and hash to the same `sha384` SRI values the old code pinned for unpkg: the
browser executes the same bytes and only the origin changed. `@babel/standalone` is not
vendored — 2.8 MB reached only by JSX `<x-import>`, which neither page uses — and now fails
with an explanation instead of a network call. Google Fonts is once again the only external
asset either page loads.

No contract change; nothing under `server/`, `cli/`, `runner/` or `spec/` moves.

## v0.5.0 — 2026-08-23

Two contract moves reach a tag here. `0.4.0` was bumped in-tree when M4-5
landed and never tagged, released, or published as an image, so no consumer
could pin it; it ships inside this release rather than being retro-tagged, and
its entry is kept below verbatim. Both moves are additive — a client generated
against `0.3.0` is unaffected by either.

### 0.5.0 — the org storage quota

**M4-3: the per-org storage quota.** `orgs.max_storage_bytes` — the last of
the four org quotas, and the one the milestone never built. It was deferred to
M4-8 ("it needs the object store to meter against") while M4-8's own sizing was
deferred to it ("depends on M4-3's storage-quota shape existing to bound it"),
a deadlock that held for the whole milestone with nothing bounding how much one
org could write. It is broken from this side: the meter counts the bytes that
exist today — an org's rows in Postgres plus its git repos on disk — and gains
the object store as a third term the day there is one, without the ceiling's
shape changing.

Additive: `max_storage_bytes` joins the `PATCH /api/adp/orgs/{orgId}` body and
the `quotas` object on org detail. The latter is a wider shape than the three
counting quotas (`OrgStorageQuota`), because a measured `used` can be null and
carries the `measured_at` that says how stale it is.

Three behaviors worth knowing before setting a ceiling. **The meter is
sampled, not synchronous** — a ten-minute tick
(`STORAGE_METER_INTERVAL_MS`), because measuring is a full scan of the org's
rows in ten tables and cannot live on the trajectory hot path; that interval is
exactly the overshoot an org can achieve past its ceiling. **An org that has
never been metered is under quota, not over** — `storage_bytes_used` is null
until the first tick, and failing closed on null would refuse every write on
every instance for one interval after every restart. And **gate-job completion
is never refused**: the gate has already run, so refusing would wedge the job
until the reaper and leave its signed evidence unwritten, blocking any commit
under a `gates_green` policy — a storage quota turning into a land outage.
Instead the completion lands and its logs are dropped, with the drop recorded
on the operation so the empty `logs` reads as a decision rather than data loss.

Reads are never refused. An org at its ceiling can still clone what it already
has, because a quota that takes the data hostage is a lockout, not a ceiling.

New gauge: `adp_storage_bytes{org}`, the first storage metric this server has
had. `docs/observability.md` §5 amends its own "no per-org labels" position to
say why this one is the exception.

### 0.4.0 — OIDC login (shipped here, never separately released)

**M4-5: OIDC login (#103).** The standard authorization-code flow with PKCE,
mapped onto `identities` through a new `external_identities` table keyed on
`(issuer, subject)` — not on email, because Google's `sub` is the stable
identifier and an address that gets reassigned must not hand over an account.

Additive: two new operations, `GET /auth/oidc/start` and
`GET /auth/oidc/callback`. No existing operation changes shape, and both
routes are absent entirely on an instance with no IdP configured, so a client
generated against 0.3.0 keeps working untouched.

Two things worth knowing before enabling it. **Auto-provisioning is off by
default** — `OIDC_ALLOWED_DOMAINS` is empty, and empty means a verified
account with no existing link is refused rather than welcomed. And a login
mints `repo:read` + `repo:write` only; **`admin` is not reachable from the
login route by any input**, the same bound `POST /api/adp/tokens` carries.

ID tokens are verified against Node's own crypto rather than a JWT
dependency, with an allowlist of exactly one algorithm. The negative cases —
algorithm confusion, `alg: none`, unknown `kid`, tampered payload, wrong
issuer, wrong audience, expired, replayed nonce — are each a test, because
that is the only thing that makes the trade sound.

## v0.3.0 — 2026-08-14

The coordinated breaking contract release (#97), plus the full M4
post-landing-audit remediation (tracked in #87) — every fix its own PR carrying the audit's named
negative-case test.

**Security (P0).**
- Gate-job checkout/complete bind to the identity that claimed the job
  (#88) — previously any `runner` token could tarball any org's source and
  forge signed gate evidence.
- `repos(owner,name)` unique; `owner` validated against path traversal;
  `repos.org_id` NOT NULL and indexed (#89).
- `POST /api/adp/tokens` mints bounded tokens; `admin` no longer satisfies
  `runner` (#90).
- Org isolation enforced on every plane — REST, git http, GraphQL,
  `/api/adp` — with explicit, audited org provisioning and the
  org-isolation matrix test, M4 exit criterion #1 (#91).

**Queue reliability (P1a).**
- Claims are leases; a reaper requeues what a dead runner held, up to a
  retry cap, with operations recorded at every lifecycle transition, an
  `oldest_running_age` gauge, and an alert on the reaper itself (#92).
- `FOR UPDATE OF gate_jobs` — issue/PR numbering no longer starves the
  claim path (#93).
- All three org quotas enforce inside the transactions that consume them
  (#94). Completion and its signed evidence are one transaction (#95).
- Background writers (sweeper, reaper) take advisory locks — a second API
  replica is safe (#96).

**Contract (breaking).**
- `ADP-API-Version` 0.2.0 → 0.3.0, with an operation-set snapshot guard so
  the version can never silently not-move again.
- Every 4xx carries a shared `Error` schema; validation errors are a stable
  `{path, message, code}` projection, never raw validator internals.
- Auth and per-operation scopes declared in the spec (`x-required-scope`)
  and asserted against the code in both directions.
- Every list endpoint is bounded: `per_page`/`page` on the compat plane,
  `limit` + `ADP-Next-Cursor` keyset cursor on the native plane. The
  gate-jobs listing no longer inlines `logs`.
- Org administration (quota ceilings, policy repo, kill switch) has
  audited REST write paths, and org-level operations appear in the org
  audit-log export.
- The run/compare/verify/eval responses squad-lab consumes are typed.
- URLs keep `{owner}/{repo}`: the owner string is the org's immutable URL
  slug; org rename is unsupported pre-1.0 by design.

**Hardening & hygiene (P2).**
- Gate containers: `--cap-drop=ALL`, `--security-opt no-new-privileges`,
  `--pids-limit`, and a host-operator image allowlist
  (`RUNNER_IMAGE_ALLOWLIST`) (#100).
- The acceptance walkthrough runs in CI; `make runner` requires a real
  docker daemon; every self-skipping suite routes through the shared
  skip-into-failure guards (#99).
- `web/` runs tests in CI, with its hand-copied server enums bound to
  their sources (#98).
- This release identity itself: tag, GitHub release, published image with
  digest, `image:` in the compose file (#101).

## v0.2.0 — 2026-08-05

Runs carry `labels`; a compare row carries every named eval alongside the
single latest one. Additive.

## v0.1.0 — 2026-08-04

First versioned contract: runs, hash-chained trajectories, evals as gate
evidence.
