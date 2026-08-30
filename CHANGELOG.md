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

## Unreleased

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

`bench/arms/three-way-cost.mjs` no longer contains a `curl` in the `adp-mcp`
arm — not in the instructions, and not in `allowedTools` either, so a trial
cannot quietly fall back to the shape the arm exists to stop measuring.
**The arm has not been re-run**: it is agent-backed, needs real tokens and a
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
