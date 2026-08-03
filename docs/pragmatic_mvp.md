# ADP — Concept Review, MVP Definition, and Infrastructure Plan

## Context

`docs/agent-native-vcs-brief-v5.md` argues for a neutral, open, agent-native substrate for version
control and CI/CD (ADP). `docs/adp-prototype-implementation-plan.md` proposes a 24-week, 6-engineer
prototype. When this plan was first written the repo held two documents and no code; implementation
is now underway against it — see the status ledger in Part 3 and the dated addendum in §1.5.

The ask here is narrower and more useful than the existing plan: **an MVP that an agent can use
instead of GitHub**, deferring everything complex. That reframing is load-bearing. The existing plan
optimizes for "prove the brief's three theses to a frontier lab." This plan optimizes for "an
off-the-shelf agent completes its whole outer loop against our server and we learn what actually
breaks." The second is a precondition for the first.

**Decisions taken (locked):**

| Decision | Choice | Consequence |
|---|---|---|
| Success test | **Unmodified agent, zero config** — point `GH_HOST` at us, no MCP setup, no code changes | GitHub REST *and* GraphQL compatibility is MVP-critical, not deferred |
| `gh` CLI | **Works in MVP** | ~14 GraphQL operations must ship; adds ~2.5 weeks |
| Stack | **TypeScript + Node** | Fast surface-area iteration; git plumbing via subprocess |
| Forge | **Greenfield over plain git** | Bare repos + `git http-backend` + our own Postgres domain model |

Everything below is written against those four.

---

# Part 1 — Concept review

## 1.1 What holds up

- **Git-compatible surface over non-Git internals is validated,** not speculative. Five independent
  teams converged; [Cursor Origin](https://www.eesel.ai/blog/what-is-cursor-origin) shipped exactly
  this in June 2026. This is now a baseline, not a differentiator.
- **Verification as the bottleneck is correct and under-served.** When agents author most code, the
  scarce resource is trustworthy attestation, not keystrokes.
- **Binding intent → diff → evidence → provenance at land time is the strongest idea in the brief**
  and is genuinely unoccupied. Entire and Diversion capture context; neither gates on it.
- **The harness-boundary analysis (§e) is the sharpest section.** Harnesses privately reimplementing
  checkpointing, session persistence, memory, and workspace orchestration is real and observable.

## 1.2 Where the concept is weak

**A. The LSP analogy is the wrong precedent, and it hides the hard part.**
LSP won because the M×N problem was symmetric and neither side wanted the other's state: the editor
kept the buffers, the server answered questions. ADP as specified is asymmetric — *the substrate owns
the state*. Asking a harness vendor to adopt ADP is not "adopt a query protocol," it is "move your
session state, your memory, and your customer's source code onto a third party's server." That is a
database migration, not an integration, and it is why adoption will be much harder than §e implies.

The better precedent is **OpenTelemetry**: it standardized *emission* — of precisely our payload,
provenance and evidence — without requiring anyone to move their system of record, and it won.
Consequence: ADP's adoptable core should be *record formats plus a verb set that works against a repo
you already have*. This is what makes **mirror mode** (§3, M2) strategically important rather than a
nice-to-have.

**B. "Neutral standard" and "replace GitHub" are in tension; the docs pick the harder one first.**
The brief says the forge API is the prize, then cuts the GitHub shim to webhooks and statuses. But
the success test we've now locked is exactly a forge test. Sequence them: **be a usable forge first
(concrete, testable), extract the standard second.** A spec with one implementation and no users is
not a standard; it is a document. The `spec/` directory and conformance suite are cheap to maintain
from day one — but they are the *byproduct* of a working forge, not the deliverable.

**C. The real switching cost is the integration estate, not the token tax.**
The brief's central mechanism — "Git familiarity is a per-token performance tax" — is true but is not
what keeps organizations on GitHub. That is Actions, SSO/SCIM, Dependabot, code scanning, branch
protection, CODEOWNERS, audit export, and dozens of webhook integrations. The *agent* is rarely
blocked; the *org* is blocked on compliance and plumbing. Two consequences:
- Don't try to win the integration estate — it is unwinnable. Target **greenfield agent workloads
  and speculative fan-out**, where no estate exists yet.
- "Keep GitHub as system of record, add ADP alongside" is the only genuinely low-friction adoption
  path. Hence mirror mode at M2.

**D. The verification fabric is scoped as infrastructure, but its defensible core is policy.**
A hermetic, Bazel-compatible, remote-cached incremental build graph is a decade-long product with
three well-funded incumbents. The brief calls it "the lead," then quietly descopes it to "pluggable
gate runners" — which is CI. The novel *and* cheap pieces are the **evidence bundle schema** and
**statistical land criteria under stochastic gates** (A8). Those are a schema and a policy engine.
Build them; run gates in containers like everyone else; do not write a build system.

**E. The novel primitive is buried, and it is not the merge queue.**
Merge queues serialize *independent* changes — solved and commoditized (GitHub, Graphite, Mergify,
Aviator). What no forge has is a primitive for **N competing candidate solutions to one intent**: fan
out 50 attempts, score them against the same gates, land one, keep 49 queryable and out of history.
That is the actual shape of agent-fleet work, it has no GitHub analogue, and it is cheap once
proposals exist. It belongs in the MVP; speculative batching does not.

**F. The read path is ignored, and it is where agents spend their tokens.**
Both docs are about the write path (fork → change → land). Agents burn most of their budget
*reading*: `git log -p`, `git blame`, "why is this like this," "what broke this." A substrate holding
intent + evidence + provenance in a database answers those in one typed query instead of 40k tokens
of scrollback. Oak's "~50% fewer VCS tokens" claim lives here. **A semantic history-query API is
probably the cheapest large agent win available, and it appears in neither document.**

**G. Cut-list items that are actually load-bearing.**
- *"Cut multi-tenant auth; each partner runs an isolated instance."* Ship single-tenant *data*
  isolation, but build token-scoped auth from commit 1 — it is middleware, not a subsystem, and
  retrofitting identity into a provenance system is not viable.
- *"Rust, gRPC, jj-lib, gitoxide."* A five-year architecture chosen at week 0. For an MVP whose
  deliverable is API surface breadth, Rust spends the budget on the wrong problem; gRPC adds codegen
  and proxy cost with zero MVP consumer; jj-lib imports the doc's own unsolved A4 research problem
  into week 2. (Superseded by the locked decisions above.)
- *Five repos from the first commit.* Premature. One public monorepo, `spec/` as a directory.

**H. Git projection fidelity is asserted as "borrow, zero innovation budget." It is not.**
With first-class conflicts, typed changes, and undo-of-landed-changes, projecting into a git DAG is
lossy and full of edge cases (what does a conflicted change look like to `git clone`? what does undo
look like to someone who already fetched?). Sapling/Mononoke took years. **Resolution: don't project.
Git *is* the store; ADP is an overlay beside the DAG.** Fidelity risk goes to zero, `git` works by
construction, and the ADP *API* — the actual standard — is unchanged. The brief already concedes the
principle ("the spec, not the codebase, is the commitment"); the MVP exploits it maximally and defers
the jj-derived engine entirely.

## 1.3 Competitive blind spots

| Blind spot | Why it matters |
|---|---|
| **GitHub is already moving.** [Agent apps in Marketplace](https://github.blog/changelog/2026-06-02-extend-github-with-agent-apps/) and an [agent-native Copilot desktop app](https://github.blog/news-insights/product-news/github-copilot-app-the-agent-native-desktop-experience/), both H1 2026. | This is risk A10 materializing *now*. Distribution beats architecture. A10's fallback (become the open **conformance layer**) should be treated as the likely case — which argues for `spec/` + `conformance/` being real artifacts early. They are cheap, and they are the hedge. |
| **Forgejo/Gitea already exist and already fail your exact test.** Mature, self-hostable, GitHub-*shaped* — and `gh` does not work against them because [they expose no GraphQL](https://github.com/IoTReady/forgejo-cli). | Two conclusions. (1) Forking Gitea would have bought a forge but *not* agent fluency, while importing a large Go codebase built for human workflows — this is why greenfield is right. (2) The absence of any gh-compatible open forge is an unfilled gap, and it tells you the expensive part of "usable instead of GitHub" is GraphQL, not REST. |
| **`gh` is GraphQL-first.** `gh pr view/list/status/checks/merge` and `gh issue list/view` are all GraphQL. | Any REST-only shim leaves `gh` broken. Now scoped explicitly in §2.4. |
| **Harness vendors may standardize among themselves.** Claude Code and others already ship git-worktree isolation and their own checkpointing. | The §e drift may resolve via a harness-side convention (cheap, no server) before a substrate standard lands. ADP's pitch must be what a harness *cannot* do locally: cross-harness, durable, signed, server-side history and evidence. |
| **Agent-sandbox platforms (Freestyle, Daytona, E2B) already sell "git + environment via API."** | They own the adjacent workflow and could add proposals/evidence more easily than ADP could add sandbox infrastructure. Argues for ADP explicitly *not* owning execution environments and keeping a clean integration seam. |
| **Nobody has costed being system-of-record for a lab's source code.** | Tier-0 security asset, DR obligation, availability SLO, data residency. Another reason mirror mode matters: ADP can be *additive* before it is *authoritative*. |

## 1.4 What changes about the concept

1. Sequence **usable forge → measured adoption → extracted standard.** Not standard-first.
2. Make **mirror mode** a first-class product mode (M2).
3. Promote **candidate sets** and the **semantic history-query API** to headline differentiators;
   demote speculative merge batching and the build graph.
4. Defer the jj-derived change engine; ship the ADP verb set and record schema over plain git.
5. Treat `spec/` + `conformance/` as the durable artifact. The server is replaceable.

## 1.5 Addendum (2026-07-26) — the trust plane, and what the first code taught us

Two inputs since this plan was written: **brief v5 added §f** (enterprise controls and
supply-chain security as a "trust plane"), and **M0 plus the core of M1 are implemented** and
green in CI (see the status ledger in Part 3). Both change the milestone plan below; neither
reopens the four locked decisions.

**From §f — argued fully in the brief, sequenced here.** The target segment treats
Dependabot-class dependency management, secret scanning with push protection, and admin-enforced
policy as procurement gates, and the 2025–26 threat data (slopsquatting, ~2× secret-leak rates in
AI-co-authored commits, worms harvesting CI tokens) says those controls belong at **admission
time, server-side** — client-side pre-commit hooks are advisory to an agent (`--no-verify` is one
token away); external pre-commit scanners like Wiz CLI remain welcome as a latency optimization,
with the substrate as the enforcement backstop. The MVP inherits only the retrofit-hostile slice,
ranked by cost-of-retrofit:

1. **Evidence bundles serialize as in-toto/DSSE attestation envelopes** from the first
   implementation (M1c). Choosing the envelope now is nearly free; converting stored evidence
   later is a migration. The gate runner design is otherwise unchanged.
2. **Land-policy resolution is two-level from day one:** an instance-level floor (server config,
   admin-owned, non-bypassable) ∧ repo-level `adp.yaml`. Single-tenant stand-in for the org ∧ repo
   resolution the brief describes; the resolver is the durable part, the org model is M4.
3. **The receive path gets one hook subsystem serving two jobs:** post-receive auto-recording of
   changes (already noted as follow-up in `changes.ts`) and pre-receive push protection (bundled
   secret engine behind a provider API). Build it once.
4. **Scanner integrations are gate adapters, dependency admission is a gate** (M2): SARIF/JSON in,
   evidence attestations out, `wizcli` as the reference adapter; lockfile-diff admission checks
   against OSV + the OpenSSF malicious-packages feed with cooldown windows. Neither is a scanner
   we build — no first-party SAST/SCA, ever (brief v5 A13 names what would change that).
5. Everything else in §f (org policy console, SSO/SCIM, audit export surface, fleet kill switch as
   product UX) stays M4.

**From the code — review findings (2026-07-26), all pre-M1-exit hardening:**

- **`git push` breaks at 1 MiB:** the git routes inherit Fastify's default `bodyLimit`, so any
  real-sized pack 413s. Raise the limit on the git routes now; move pack bodies to streaming
  (both directions — they are currently fully buffered) before any fleet-scale test.
- **Token scopes are minted but never enforced** — any valid token can push. Enforcing
  `repo:read`/`repo:write`/`admin` at the routes is small, and it is the seed of the policy plane.
- **Read-auth is inconsistent:** REST/GraphQL reads are unauthenticated while git transport
  requires a token. Decide once: default-private (reads require a token) until instance policy
  can say otherwise.
- **Auth is O(n · scrypt) across all tokens per request.** Commented and fine single-tenant;
  needs a keyed lookup (embed a token-id prefix in the token format) before fleet fan-out (M3).
- **`SIGNING_KEY` doc/code mismatch:** `.env.example` says generate with `openssl genpkey`; the
  code derives the Ed25519 key from the env string via SHA-256. Fix the doc; per-agent keys stay
  deferred as planned.
- **Known-fidelity gaps to feed the record-replay suite:** proposals and issues number
  independently (GitHub shares one sequence); repo creation lives at a nonstandard path
  (`POST /api/v3/repos/:owner` vs GitHub's `POST /user/repos` · `POST /orgs/{org}/repos`);
  GraphQL actors always resolve as `User`, never `Bot`, even for agent identities.

---

# Part 2 — The MVP

## 2.1 Definition of done

> Set three environment variables. An off-the-shelf coding agent — no MCP config, no code changes,
> no ADP knowledge — completes a full development cycle with no GitHub involved: `git clone`s, reads
> the issue with `gh issue view`, edits, pushes, `gh pr create`, watches `gh pr checks` go green,
> `gh pr view` shows a typed review, `gh pr merge` lands it. A human then opens the ADP web UI and
> sees the intent, the signed evidence bundle, the provenance (harness / model / session), the
> operation log — and clicks undo.

```bash
export GH_HOST=adp.example.com
export GH_TOKEN=adp_pat_...
git config --global credential.https://adp.example.com.helper '!f(){ echo "username=x-access-token"; echo "password=$GH_TOKEN"; };f'
```

Explicitly **not** in the definition of done: GitHub API parity, Actions, scale, multi-tenancy, VFS,
structural merge, a build graph.

## 2.2 The two planes

The locked decisions produce a clean architecture. The MVP has two surfaces over one domain layer:

| Plane | Surface | Obligation | Purpose |
|---|---|---|---|
| **Compat plane** | git smart-HTTP + REST `/api/v3` + GraphQL `/api/graphql` | Must be *faithful* — a broken `gh` is worse than an absent one | Zero-config adoption. This is the MVP's tier-1 obligation. |
| **Native plane** | ADP REST + MCP (~8 tools) | Must be *expressive* | The primitives GitHub structurally cannot express: workspaces, candidate sets, evidence bundles, op log/undo, history query. |

**Progressive disclosure is the design principle.** The differentiated value surfaces *through* the
compat plane wherever it can be projected, so an unmodified agent benefits without knowing ADP exists:

| ADP concept | Projection an unmodified agent sees | Native plane gives you |
|---|---|---|
| Intent | PR body + linked issue | Typed object, queryable, links candidates |
| Evidence bundle | Check-run with summary + annotations + `details_url` | Signed bundle, artifact refs, land decision record |
| Provenance | Commit trailers (`ADP-Agent:`, `ADP-Model:`, `ADP-Session:`) + signature | Identity graph, session linkage |
| Workspace | A branch `adp/ws/<id>` | Lifecycle, TTL, GC, isolation |
| Candidate set | Label + an index issue listing members | Real object, selection policy, scored comparison |
| Operation log / undo | *(no analogue)* | Native only — the audit and safety story |

This also resolves a real risk: if the GraphQL slice proves flakier than hoped, the native plane is
an intact fallback rather than a second half-built system.

## 2.3 Inclusion rubric

Everything in the MVP sits on the agent's **outer loop**. Nine steps, one capability each. Not on the
loop ⇒ out.

| # | Agent needs to… | MVP capability | Why it can't be cut |
|---|---|---|---|
| 1 | get the code | git smart-HTTP | Non-negotiable; everything assumes a working copy |
| 2 | know the task | issues + `intent` on changes | Intent is the payload the thesis rests on |
| 3 | get an isolated place to work | workspaces (projected as branches) | The one primitive fleets need that git lacks |
| 4 | record work | typed change: diff + intent + provenance | The defining record; cheap as metadata beside a git commit |
| 5 | propose it | proposals (PR-shaped) | The unit review and landing attach to |
| 6 | get it verified | gate runner + evidence bundle | Differentiator #2; without it landing is unattested |
| 7 | get it reviewed | typed review states | Agents can't parse emoji threads |
| 8 | land it | land with policy check | Closes the loop |
| 9 | audit / undo | op log, undo, history query | Op log cannot be retrofitted; history-query is the token win (§1.2F) |

Plus one deliberate addition off the loop:

| Extra | Why it earns its place |
|---|---|
| **Candidate sets** | The only MVP feature GitHub structurally cannot express. It is the demo. Cost ≈ one table + a selection endpoint once proposals exist. Without it the MVP is "a worse GitHub." |

## 2.4 GitHub surface: exactly what ships

### Tier 1 — git wire protocol: 100%

Smart HTTP only: `GET /{o}/{r}.git/info/refs`, `POST .../git-upload-pack`, `POST .../git-receive-pack`
— delegated to the real `git http-backend` CGI behind auth middleware. Covers
clone/fetch/pull/push/ls-remote/shallow/partial/force-push. **Delegating to git itself makes perfect
fidelity free, and fidelity here is worth more than every other compatibility decision combined.**
No SSH (agents in sandboxes use HTTPS + token; SSH is a key-provisioning problem with no payoff).

### Tier 2 — REST at `/api/v3` (~24 endpoints)

`gh` treats any non-`github.com` host as GitHub Enterprise Server and derives
`https://HOST/api/v3/` — verified against [cli/cli `ghinstance/host.go`](https://raw.githubusercontent.com/cli/cli/trunk/internal/ghinstance/host.go).
Mounting there also means `gh api`, Octokit, and CI libraries work with one env var.

| Group | Endpoints | Defense |
|---|---|---|
| Identity | `GET /`(with `X-OAuth-Scopes`), `GET /user`, `GET /rate_limit` | `gh auth status` and every Octokit client probe these first; without them clients hard-fail before doing anything |
| Repo | `GET`/`HEAD /repos/{o}/{r}` | Default-branch and existence resolution; universally required |
| Read-without-clone | `GET /repos/{o}/{r}/contents/{path}` | Heavily used by agents to read one file cheaply — direct token savings |
| History | `GET .../commits`, `.../commits/{sha}`, `.../compare/{b}...{h}` | The read path in a vocabulary clients already know |
| Git data | `GET/POST .../git/refs`, `POST .../git/blobs`, `.../git/trees`, `.../git/commits`, `DELETE .../git/refs/heads/{b}` | Commit with no working copy — a real fleet pattern, nearly free over a git backend; the DELETE is what `gh pr merge --delete-branch` calls |
| Proposals | `POST/GET .../pulls`, `GET/PATCH .../pulls/{n}` (+`Accept: …diff`/`…patch`), `GET .../pulls/{n}/files`, `PUT .../pulls/{n}/merge` | The loop. `gh pr diff` is REST-only and cheap to serve |
| Discussion | `GET/POST .../issues`, `GET/PATCH .../issues/{n}`, `GET/POST .../issues/{n}/comments` | Where intent enters the system and the human↔agent channel lives |
| Review | `POST/GET .../pulls/{n}/reviews` | Machine-readable review state — a core claim |
| Evidence | `POST .../check-runs`, `GET .../commits/{ref}/check-runs`, `POST .../statuses/{sha}`, `GET .../commits/{ref}/status` | Evidence in the shape existing CI already emits and reads — the cheapest on-ramp there is |

**Not implemented:** search, Actions/workflows/runs *(except the read-only mirror-mode passthrough
at M2 — see below)*, releases, packages, orgs/teams/members, projects,
deployments/environments/secrets, branch protection, code scanning, Dependabot, notifications,
gists, stars, forks-as-social-object, third-party webhooks (one outbound emitter at M2).
Unsupported endpoints return `404` with a JSON body naming the ADP equivalent — a broken call that
*explains itself* costs an agent one turn; a hang or a 500 costs it the trajectory.
Branch protection, code scanning, and Dependabot stay unimplemented *as API surfaces*; their
capabilities arrive natively through the trust plane — land-policy floor, push protection,
dependency admission, scanner adapters (§1.5) — not as endpoint emulation.

**Actions is a special case of that distinction, and the most commonly misread one.** "Not
implemented" refers to the *API surface* (`/actions/runs`, `/actions/workflows`), not to the
capability. In mirror mode (M2) the repo stays on GitHub, so **GitHub Actions keeps running on
GitHub's runners, unchanged**, and its results arrive in ADP as evidence through webhook ingest —
`check_run`, `workflow_run`, `status`. That is full fidelity for every Actions feature there is
(marketplace actions, matrix, self-hosted runners, OIDC), for free, because none of it was
reimplemented. The API surface itself gains a **read-only passthrough for mirrored repos at M2** —
`gh run list` and `gh run view` proxy upstream rather than 404-ing — while non-mirrored repos and
every write path (dispatch, re-run, cancel) keep the `404`. See §2.5 and the M2 milestone for the
three distinct things "support Actions" can mean and which of them ADP does.

### Tier 3 — GraphQL at `/api/graphql` (~14 operations)

This is the MVP's single largest new-risk item, so the approach matters more than the list.

**Approach: load GitHub's published public schema SDL (`schema.docs.graphql`) into `graphql-js`
unmodified, and implement resolvers only for the fields we back.** Everything else resolves to a
proper GraphQL error rather than a validation failure. This matters because:
- `gh`'s queries *validate* against the real schema, so we never fail with "field does not exist" —
  the failure mode that makes a partial shim worse than none;
- we implement resolvers incrementally, driven by the record-replay suite (§5), instead of by reading
  `cli/cli` source, which moves;
- it dodges "perpetually chasing upstream": the schema is upstream's artifact, refreshed by a script.

Also required: `Node`/`node(id:)` with base64 `typename:id` global IDs, Relay-style connections with
cursor pagination, and the `User | Bot` actor unions `gh` selects on.

Operation inventory, derived from [`api/queries_pr.go`](https://raw.githubusercontent.com/cli/cli/trunk/api/queries_pr.go)
and [`api/queries_repo.go`](https://raw.githubusercontent.com/cli/cli/trunk/api/queries_repo.go):

| `gh` command | Needs |
|---|---|
| `gh repo view` | `RepositoryInfo` (id, name, owner, defaultBranchRef, viewerPermission, merge settings) |
| `gh pr create` | `RepositoryInfo` + `RepoMetadata` (labels, assignable actors, milestones) + `createPullRequest` |
| `gh pr list` | `repository.pullRequests` connection + `search` fallback |
| `gh pr view [--json]` | `repository.pullRequest{…}` incl. comments, reviews, `statusCheckRollup` |
| `gh pr checkout` | `PullRequestByNumber` (headRefName, headRepository) then git fetch |
| `gh pr checks` | `statusCheckRollup` on the head commit |
| `gh pr review` | `addPullRequestReview` |
| `gh pr comment` / `gh issue comment` | `addComment` |
| `gh pr merge` | `mergePullRequest` (+ `mergeStateStatus`) |
| `gh pr close/reopen/ready` | `closePullRequest`, `reopenPullRequest`, `markPullRequestReadyForReview` |
| `gh issue create/list/view/close` | `IssueRepositoryInfo`, `createIssue`, `repository.issues`, `repository.issue`, `closeIssue` |

`gh run *`, `gh release *`, `gh project *`, `gh search *` are **deliberately unsupported** and return
a clear error. Agents recover from a clean "not supported here" in one turn.

### Tier 4 — Native plane: ADP REST + MCP (~8 tools)

Deliberately *shrunk* now that `gh` covers the loop — a second surface duplicating `gh pr create`
would only degrade tool selection. MCP exposes only what has no GitHub shape:

```
adp_workspace_create / adp_workspace_destroy   # lifecycle, TTL, GC
adp_history_query        # who / what / why / how-verified over a path, range, or session
adp_evidence_get         # full signed bundle for a change
adp_op_log / adp_undo    # the audit + safety story; no GitHub analogue
adp_candidates_open / adp_candidates_select    # N solutions, one intent
```

## 2.5 Cut list

| Cut | Rationale |
|---|---|
| jj-derived change engine, first-class conflict objects | Git is the store, ADP the overlay. Removes the A4 research risk entirely. MVP conflict = failed merge → proposal `conflicted` → agent rebases (exactly what it does on GitHub today). |
| Virtual filesystem (FUSE/ProjFS) | MVP-scale repos materialize in seconds. Pure infrastructure cost, zero learning. |
| Structural / AST merge | A6 is right: the evidence gate means merge errors need catching, not preventing. |
| Speculative merge batching | Solves throughput we won't have. Serial land + re-verify-before-land is ~200 lines and captures the value. |
| Hermetic incremental build graph | Bazel exists. Run declared commands in a container. |
| Actions / workflow engine | Gates are `image + commands` in `adp.yaml`. An Actions clone is a multi-year trap. **And mirror mode means it is not a gap:** the repo stays on GitHub, GitHub runs the workflows, and the results land in ADP as evidence via webhook ingest — better fidelity than any reimplementation, since it *is* GitHub. The read API proxies upstream for mirrored repos at M2. What is genuinely cut is ADP *executing* workflow YAML, which nothing in the loop needs. |
| Orgs, teams, per-path ACLs, SSO/SCIM | Token-scoped auth covers MVP. Enterprise identity is an M4 conversation with a real customer. |
| Releases, packages, wikis, projects, discussions, gists, notifications | Not on the loop. |
| Code scanning / Dependabot as *GitHub API emulation* | The capabilities ship natively instead — push protection at the receive path (M1c), dependency admission gates and scanner-as-gate adapters (M2) — per the trust plane (§1.5, brief v5 §f). First-party scanners are never built; the bundled secret engine is the only in-tree detector. |
| Inline positional review comments (`position`/`line`/`side`) | GitHub's diff-position model is notoriously painful. MVP reviews carry body + file/line annotations; positional projection is best-effort. |
| SSH transport | Token-over-HTTPS is what agents already do. |
| gRPC | HTTP/JSON + MCP covers every MVP consumer. Add when a perf-sensitive second implementer exists. |
| S3-backed git objects, sharding, multi-region | One volume, one box. |
| Sigstore / keyless signing | Server-held Ed25519 key; schema shaped for per-agent keys later. |

---

# Part 3 — Milestones

Assumes 2 engineers. Weeks elapsed, not ideal. The `gh` decision moves the MVP from ~7 to ~11 weeks;
that is the honest price of zero-config.

## Status ledger

*Updated 2026-08-01. CI runs typecheck, build, migrations, the full three-tier test suite (114
tests, including all e2e suites), the `gh` conformance gate (`conformance/run.sh`), and the §2.1
acceptance walkthrough (`acceptance/run.sh`, plus the web UI in a real browser) on every PR — the
last two in a separate clean-room workflow that provisions a bare container from scratch and
asserts the machine is clean afterwards. A skipped e2e tier is now a hard failure rather than a
silent pass; see [`test-environment-automation.md`](test-environment-automation.md).*

| Milestone | Status | Evidence |
|---|---|---|
| M0 — walking skeleton | **✓ complete** | PR #1. CI e2e: mint token → create repo → `git clone` → `git push` → commit lands |
| M1a — domain + REST core loop | **✓ core complete** | PRs #2–#3. e2e: issue→intent → comment → signed change → proposal → typed review → ff-merge → 409 on non-ff. Tier-2 tail now done (see M1b′) |
| M1b — GraphQL + `gh` | **✓ gate met** | PR #4 (read) + the M1b′ mutation slice. GitHub's real SDL loaded unmodified; `conformance/run.sh` drives a real, unmodified, pinned `gh` v2.63.0 through `issue create/view`, `pr create/view/merge` against the live server — the definition-of-done §2.1 gate, enforced in CI on every PR |
| M1b′ — compat completion + hardening | **✓ done** | GraphQL mutations, the Tier-2 REST tail, all five hardening items, and the `gh` conformance gate all landed — see below |
| M1c | **✓ done** | Real git `pre-receive`/`post-receive` hooks; `adp.yaml` gate runner with DSSE-signed evidence bundles; two-level land policy on both REST and GraphQL merge; native-plane (`/api/adp`) op log + `adp_undo` + history-query by path; workspaces, candidate sets, and an evidence-bundle read; a real MCP server (`server/src/mcp/`) wrapping all of it as 8 tools; a read-only supervision web UI (`server/web/`, served at `/ui/*`) — see below |
| M2 — adoption + trust ramp | **✓ complete 2026-08-03** | Mirror mode, outbound webhook emitter, `adp` CLI, API-traffic telemetry, scanner-as-gate adapters (`wizcli`, `osv-scanner`), dependency admission v0, SBOM per land, all five scale-hygiene items, and the read-only Actions passthrough with its `workflow_run` ingest — see below. Scope revised 2026-07-26, amended 2026-08-01 per the pre-M2 readiness review ([`m2-readiness-review.md`](m2-readiness-review.md)). Dev environment built 2026-08-02 ([`infra/dev/`](../infra/dev/)); mirror-mode inbound proven against real github.com 2026-08-03, and both [`environments-plan.md`](environments-plan.md) §5 questions answered |
| M3 — fleet + differentiation | **in progress** | Scope clarified and sequenced 2026-08-03 by the pre-M3 readiness review ([`m3-readiness-review.md`](m3-readiness-review.md)), which also found M2's first-mirror-import provenance gap and carries the executable work plan (M3-0 … M3-6) |
| M4–M5 | not started | |

### M0 — Spec + walking skeleton (weeks 1–2) — ✓ done
`spec/openapi.yaml` + JSON Schemas (change, evidence, provenance, operation). Server boots, Postgres
migrations, token auth middleware, repo create, git smart-HTTP end to end (`git clone` → edit →
`git push`). Caddy + TLS, compose file.
**Exit:** a real repo can be pushed to and cloned from the server over HTTPS with a token. **Met —
enforced in CI on every commit since.**

### M1 — MVP (weeks 3–11) ← *this is the MVP*
Sequenced so the compat plane is provably working before the differentiators land on top:

- **M1a (wks 3–5) — domain + REST.** Issues, proposals, reviews, changes with intent/provenance,
  server signing, the `operations` table. REST `/api/v3` Tier 2 complete.
  **Status: core loop done.** Every mutation writes its `operations` row in the same transaction —
  the one hard invariant held from commit 1.
- **M1b (wks 6–8) — GraphQL + `gh`.** Public schema SDL loaded, ~14 operations resolved, global IDs,
  connections. Record-replay conformance suite green for the target command set. **Gate: definition
  of done §2.1 minus evidence/undo must pass here.** If `gh` compat is going to blow up, it blows up
  in week 8, with the native plane already a viable fallback.
  **Status: read slice done; the gate is unmet** — hand-written `gh`-shaped queries pass, the real
  `gh` binary has not yet been pointed at the server.
- **M1c — differentiators.** Revised scope below.

#### M1b′ — compat completion + hardening *(revised 2026-07-26; the current critical path)*
1. ~~**GraphQL mutations**~~ **done**: all 9 (`createIssue`, `closeIssue`, `createPullRequest`,
   `mergePullRequest`, `closePullRequest`, `reopenPullRequest`, `markPullRequestReadyForReview`,
   `addPullRequestReview`, `addComment`) implemented in `server/src/http-gql/resolvers.ts`, each
   writing its `operations` row in the same transaction as the domain mutation (the invariant from
   M1a). `addComment` only supports `Issue` subjects — PR conversation-tab comments aren't modeled
   separately from issue comments in the schema yet, a known gap. `markPullRequestReadyForReview` is
   a recorded no-op (no `draft` column — every PR is ready-for-review from creation). `User | Bot`
   actor fidelity done (`identities.kind` drives `__typename`). `PullRequestByNumber` was already
   covered by `Repository.pullRequest(number)`; `statusCheckRollup` needs no resolver — it's a
   nullable field with no CI system behind it yet, so it already resolves to `null`. Covered by
   `server/test/e2e-graphql.test.ts`'s "M1b′ GraphQL: mutations" suite.
2. ~~**Tier-2 REST tail**~~ **done**: `contents` (`server/src/http-rest/git-data.ts`), `commits` /
   `commits/{sha}` / `compare/{base}...{head}`, git-data endpoints (`git/refs|blobs|trees|commits`,
   `DELETE git/refs/heads/{b}`), PR `files` + diff/patch `Accept` media types on `GET pulls/{n}`, and
   the GitHub-standard `POST /user/repos` / `POST /orgs/{org}/repos` create paths (`repos.ts`). All
   backed by new `GitBackend` plumbing (`statPath`, `readBlob`, `listTree`, `getCommit`, `log`,
   `diffNameStatus`, `diffPatch`, `mergeBaseCount`, `listRefs`, `createBlob`, `createTree`,
   `createCommit`, `createRef`, `deleteRef`) — still subprocess-to-real-`git`, no isomorphic-git.
   `git/trees` tree-merge semantics (`base_tree` + overlay entries, `sha: null` deletes) are a
   pragmatic subset of GitHub's, not full parity. Covered by
   `server/test/e2e-git-data.test.ts`.
3. ~~**The `gh` conformance gate**~~ **done**: `server/conformance/run.sh`, wired into CI
   (`.github/workflows/ci.yml`) after the vitest suite. Downloads a pinned `gh` release (never
   whatever's on the runner's `PATH` — reproducible independent of the environment), fronts the
   plain-HTTP server with a throwaway self-signed-cert TLS proxy (`conformance/tls-proxy.mjs`; `gh`
   refuses plain HTTP for any non-`github.com` host, and there's no override), and drives the real
   binary through `issue create` → `issue view` → `pr create` → `pr view` → `pr merge`, asserting
   each succeeds and that the merge actually fast-forwards `main` server-side. **What this isn't:**
   recording and replaying HTTP exchanges captured against production github.com — that needs a
   real GitHub token in CI and is a materially larger investment than the definition-of-done gate
   calls for (§2.1: "passes with a real, unmodified `gh`"). What's here is that gate, literally: the
   actual `gh` binary, unmodified, against the actual server.

   **`gh` is pinned to v2.63.0** (2024-11-27), not latest — the newest `gh` (2.96.0 at the time of
   writing) sends `Issue.issueType` and other fields tied to GitHub's newer "Issue Types" feature
   that aren't in the octokit/graphql-schema public mirror this project vendors
   (`spec/graphql/github.graphql`, refreshed from the same mirror — confirmed absent there too, not
   just in our copy), and separately trips a real graphql-js validation quirk (next paragraph).
   v2.63.0 predates both and is what the gate is pinned to until the vendored schema mirror catches
   up; bump `GH_VERSION` in `conformance/run.sh` when it does.

   **Getting the real `gh` binary this far surfaced several genuine gaps**, fixed here rather than
   masked:
   - **`GH_ENTERPRISE_TOKEN`, not `GH_TOKEN`**, is what `gh` reads for any non-`github.com`/`ghe.com`
     host — not a bug, just an easy-to-miss operational detail worth recording for anyone else
     pointing `gh` at this server.
   - **A graphql-js false positive**: `gh issue view`'s query selects same-named, differently-typed
     fields (`state: IssueState!` vs. `PullRequestState!`) inside mutually exclusive `... on Issue` /
     `... on PullRequest` fragments on the `IssueOrPullRequest` union — legal by spec (the fragments
     can never both apply), accepted by real GitHub's server, but flagged by graphql-js's
     `OverlappingFieldsCanBeMergedRule` anyway. `server/src/http-gql/route.ts` now validates with that
     one rule excluded from `specifiedRules`, confirmed by direct testing to introduce no other
     validation gap — the same kind of graphql-js/real-schema impedance mismatch `schema.ts` already
     works around for `@deprecated`.
   - **Resolver gaps closed** (`server/src/http-gql/resolvers.ts`): `Repository.issueOrPullRequest`
     (unimplemented; `gh issue view`/`gh pr view` both route through it since real GitHub shares one
     number sequence across issues and PRs); a set of non-null `Repository` fields `gh` reads
     incidentally (`hasIssuesEnabled`, `hasProjectsEnabled`, `hasWikiEnabled`,
     `hasDiscussionsEnabled`, `isArchived`, `isEmpty`, `isFork`, `isTemplate`, `mergeCommitAllowed`,
     `rebaseMergeAllowed`, `squashMergeAllowed`, `deleteBranchOnMerge` — all permissive defaults, no
     per-repo configuration exists yet); non-null `Issue`/`PullRequest` fields with no backing data
     model yet (`assignees`, `labels`, `milestone`, `reactionGroups`, `projectCards` — empty/null,
     an honest "not implemented" rather than an error); `Issue.comments` (real, backed by
     `issueComments`); `PullRequest.{isCrossRepository, headRefOid, mergeStateStatus,
     isInMergeQueue, isMergeQueueEnabled, maintainerCanModify}` (permissive defaults); and
     `PullRequest.{additions, deletions, changedFiles, commits}`, genuinely computed from
     `GitBackend.diffStat`/`.log` (new `GitBackend` method), not stubbed.
4. ~~**Hardening (§1.5 list)**~~ **done**:
   - **git-route `bodyLimit` + streaming pack bodies** (`server/src/http-git/proxy.ts`): the request
     content-type parser now hands back the raw stream instead of buffering (`main.ts`); it's piped
     through a byte-counting `Transform` guard straight into `git http-backend`'s stdin, and the CGI
     response is split into headers/body by `splitCgiResponse` and streamed straight to the client via
     `reply.hijack()` + `reply.raw` — neither direction is ever fully materialized in memory. The limit
     is configurable via `GIT_MAX_PACK_BYTES` (`config.ts`, `deploy/.env.example`; default 500 MB),
     replacing Fastify's 1 MiB default that used to 413 any real-sized pack.
   - **Scope enforcement** (`server/src/auth/plugin.ts`): `requireScope("repo:read" | "repo:write")`
     now gates every REST route (reads too — see below), the whole GraphQL endpoint, and the git
     smart-HTTP route (push needs `repo:write`, clone/fetch needs `repo:read`); `repo:write` also
     satisfies a `repo:read` requirement, and `admin` satisfies both, via the shared `hasScope` helper.
     GraphQL mutations check the same via `requireIdentity` in `resolvers.ts`.
   - **Default-private reads**: every REST `GET` route that used to have no `preHandler` now requires
     `repo:read`; the GraphQL route requires it too, surfaced as a GraphQL `errors` entry rather than a
     bare REST 401/403 so `gh`-shaped clients see it the way they expect.
   - **Keyed token lookup** (`server/src/auth/tokens.ts`, `db/schema.ts`): `tokens.lookupKey` (indexed,
     `sha256(token)`) narrows `authenticate()` to a single-row lookup instead of scrypt-verifying every
     unrevoked token in the table; the scrypt check against `tokenHash` is still what actually
     authenticates, `lookupKey` is only a fast filter. Migration `0003` backfills a random placeholder
     for pre-existing rows (no production tokens exist yet at this point in the MVP).
   - **`SIGNING_KEY` doc fix** (`deploy/.env.example`): corrected to say the key is derived via
     SHA-256 of any secret string, not an `openssl genpkey` PEM keypair — matches what
     `core/signing.ts` has always actually done.
   
   Covered by new tests in `server/src/http-git/proxy.test.ts` (streaming a multi-MB push, and a
   configured-`bodyLimit` 413 case) and `server/test/e2e.test.ts` (default-private reads, read-only
   vs. write-scoped tokens).

**Gate (unchanged in substance):** definition of done §2.1 minus evidence/undo passes with a real,
unmodified `gh` — `gh issue view` / `pr create` / `pr view` / `pr merge` against the server.

#### M1c — differentiators *(revised 2026-07-26: trust-plane slice folded in, §1.5)*
- ~~**Receive-path hook subsystem**~~ **done**: one mechanism, two consumers, implemented as real
  git `pre-receive`/`post-receive` hooks written into every bare repo at creation time
  (`GitBackend.initBareRepo`, `server/src/core/git-backend.ts`'s `hookScript`) — not a simulation of
  hook behavior, actual hooks `git receive-pack` invokes on every push.
  - **post-receive auto-records typed changes on push** (`server/src/http-git/hooks.ts`): for each
    ref update, resolves the new commits (`GitBackend.log`) and inserts a signed `changes` row per
    commit not already recorded, deduped by `(repoId, gitSha)` — this is what `changes.ts`'s comment
    called "wiring automatic recording into the push path," now done. Provenance is the pushing
    identity (see below), `via: "push"`.
  - **pre-receive runs push protection**: bundled regex+entropy secret engine
    (`server/src/core/secret-scan.ts`, `BundledSecretScanProvider` behind a `SecretScanProvider`
    interface — the "pluggable provider API" is that interface; only the bundled engine is
    implemented so far, external scanner adapters are M2 scope, §1.5 item 4). A finding rejects the
    push at the wire with a typed, actionable error (which line, which pattern) — **non-bypassable**
    because there's no per-repo `adp.yaml` config surface yet to turn it off; the instance-wide
    default *is* the floor for now.
  - **The one real subtlety**: `pre-receive` runs before refs move, while pushed objects still sit
    in git's per-push *object quarantine* (`GIT_OBJECT_DIRECTORY`/`GIT_ALTERNATE_OBJECT_DIRECTORIES`,
    set only in the hook process's own env) — a *separate* process (this server, reached over HTTP)
    can't see those objects yet. So the hook script computes its own diff locally (inheriting the
    right env for free, as a child of the hook process) and ships the diff **text** to the server for
    scanning; only `post-receive` (after refs move, objects ordinary again) ships shas for the server
    to look up itself. Confirmed by hitting this exact failure (`fatal: bad object <sha>`) before
    fixing it — worth remembering if this pattern needs extending.
  - `http-git/proxy.ts` now passes the pushing identity's **id** (not its principal/display name) as
    `REMOTE_USER` — git forwards it verbatim to any hooks it spawns, and the hooks need to resolve it
    back to exactly one identity unambiguously (`principal` isn't a unique column).
  - The internal `/internal/hooks/{pre,post}-receive` routes (`http-git/hooks.ts`) are loopback-only
    (no bearer token — the hook has none to present; trust is scoped to "same host" instead, fine for
    the MVP's single-host deployment, docs/pragmatic_mvp.md §4.1).
  - Covered by `server/test/e2e-hooks.test.ts`: a clean push auto-records a change with a valid
    signature and op-log entry; a push containing a seeded AWS key is rejected with `git push`
    exiting non-zero and the ref never moving server-side; dedup on a replayed ref update; and the
    loopback-only guard.
- ~~**`adp.yaml` gate runner + evidence bundles**~~ **done**: evidence serialized as in-toto/DSSE
  attestation envelopes (§1.5 item 1) via `server/src/core/dsse.ts` — proper DSSE Pre-Authentication
  Encoding (`PAE(payloadType, payload)`), not a simplified stand-in, wrapping an in-toto v1
  `Statement` whose `predicateType` is `https://adp.dev/attestations/gate-result/v1`. **This server
  is the receiving/attestation end, not a code-execution runner** — same shape as GitHub's own
  Checks API (external systems report results; GitHub doesn't run the tests either). No first-party
  gate ever executes anything, matching §1.5 item 4 ("no first-party SAST/SCA, ever"); scanner-as-gate
  adapters that report into this are M2 scope. `POST /api/v3/repos/{owner}/{repo}/gates` (`name`,
  `status`, `summary`, `git_sha`) signs and stores a `gate_results` row (`server/src/db/schema.ts`;
  multiple rows per commit+name are kept, e.g. reruns — the most recent one wins for policy/rollup
  purposes, `core/gate-results-lookup.ts`); `GET .../commits/{sha}/gates` lists them. Projected onto
  the compat plane as `Commit.statusCheckRollup` in GraphQL (`http-gql/resolvers.ts`) — real
  aggregate `state`, and (M3) real `contexts`: each gate result becomes a `StatusContext` carrying
  its name, verdict, summary, and a `targetUrl` pointing at the evidence bundle, which is what makes
  real `gh pr checks` work. Deliberately `StatusContext` rather than `CheckRun` — a `CheckRun`
  belongs to a `CheckSuite` belongs to a `WorkflowRun`, an execution model §2.5 cuts, so that shape
  would misrepresent what produced the result.
- ~~**Land policy, resolved two-level**~~ **done**: instance floor (`LAND_POLICY_FLOOR` env var,
  `config.ts`, default `gates_green,one_approval`) ∧ repo `adp.yaml`'s `land.require`
  (`server/src/core/repo-policy.ts` parses `adp.yaml` off the *base* ref, same as GitHub reads
  branch protection off the target branch; a malformed file fails closed — treated as requiring
  everything — rather than silently ignored) — resolved as a **union** in
  `resolveLandRequirements` (`core/repo-policy.ts`): the repo can only add requirements on top of
  the floor, never remove one. `core/land-policy.ts`'s `evaluateLandPolicy` enforces this identically
  in both the REST `PUT .../pulls/{number}/merge` (`http-rest/proposals.ts`) and the GraphQL
  `mergePullRequest` mutation (`http-gql/resolvers.ts`), rejecting with a typed 422 /
  `BAD_USER_INPUT` listing exactly which requirements are unmet. Risk tiers by path glob are **not**
  implemented — `require` is repo-wide, not conditioned on what changed.
  - Covered by `server/src/core/repo-policy.test.ts` (resolution/union semantics) and
    `server/test/e2e-gates.test.ts` (a real merge attempt blocked with neither requirement met,
    blocked again after a failing gate report, blocked on `one_approval` alone after the gate goes
    green, then succeeding once approved — with both a failure and a success report retained as
    separate rows for the same commit).
  - `conformance/run.sh` (the M1b′ `gh` gate) now exercises this for real against the default
    floor: confirms an unreviewed `gh pr merge` is genuinely refused (422), approves the PR via the
    REST reviews endpoint, then confirms the merge succeeds — rather than weakening the floor just
    to keep that script passing.
- ~~**Op log read API + undo**~~ **done** (native plane, `/api/adp` — no GitHub analogue, per
  the compat/native table in §2.2): `GET /api/adp/repos/{owner}/{repo}/operations` (filterable by
  `actor`, `verb`, `since`/`until`, and `path` — the full history-query slice, `http-rest/operations.ts`'s
  `matchesPath`: operations carry no path column, so a `path` filter resolves the commit sha out of a
  commit-scoped target (`owner/name@<sha>`, written only by `change.create`) and asks git which paths
  that commit touched via `GitBackend.commitPaths` (`git diff-tree --no-commit-id --name-only -r --root`)
  — over-fetches from Postgres when `path` is set since the narrowing happens in application code, then
  truncates to `limit`) and `.../operations/{id}`. `operations` has no `repoId` column (it's been
  repo-agnostic in shape since commit 1, and adding one is a bigger migration than this read API
  calls for) — repo-scoping instead matches on `target`'s shape: every target this codebase writes
  is either exactly `owner/name` or `owner/name` immediately followed by `#` or `@`, so
  `server/src/http-rest/operations.ts`'s `repoTargetFilter` is a precise match, not a fuzzy prefix
  (`"acme/widget"` can't accidentally match a target starting with `"acme/widget2"`).
  `POST .../operations/{id}/undo` (`core/undo.ts`) implements the one undo case scoped so far —
  reverting a fast-forward merge (`verb: "proposal.merge"`) — by moving the base ref back to its
  pre-merge sha via the same compare-and-swap `GitBackend.fastForwardRef` the merge itself used
  (nothing about that method actually requires moving forward; the ff-only restriction lives in the
  caller's separate `isAncestor` check, not in `update-ref` itself). **Refuses to undo if the branch
  has moved since** — winding it back further would silently drop whatever landed after — and
  refuses a second undo of the same operation. Other verbs aren't undoable yet: an honest 422, not
  a no-op that pretends to have worked. Covered by `server/test/e2e-operations.test.ts` (list +
  filter, undo reverting the ref and reopening the PR, a rejected second undo, and a rejected undo
  once the branch moved).
- ~~**MCP native plane (8 tools)**~~ **done**: `server/src/mcp/server.ts`, built on
  `@modelcontextprotocol/sdk`. Every tool is a thin wrapper over the real `/api/adp` REST
  endpoints via `server/src/mcp/client.ts` — the MCP server holds no domain logic of its own, so
  "what can undo do" stays defined in exactly one place (`core/undo.ts`), not duplicated for a
  second protocol. Run with `ADP_SERVER_URL=... ADP_TOKEN=... npm run mcp` (stdio transport).
  - `adp_workspace_create` / `adp_workspace_destroy`: a workspace is deliberately just a git branch
    with lifecycle metadata (`workspaces` table + `core/workspaces.ts`), matching the doc's own
    projection ("Workspace | A branch `adp/ws/<id>`") — not a new isolation mechanism. Destroying
    one deletes the ref for real (via `GitBackend.deleteRef`) and marks `destroyedAt` rather than
    deleting the row, so the op log stays complete.
  - `adp_history_query` / `adp_op_log`: both wrap the same operations-list query already built for
    the REST op log (filter by actor/verb/date/path) — "history query" is the richer framing, "op log"
    the raw one, over one underlying function.
  - `adp_evidence_get`: `core/evidence.ts` assembles — doesn't store — the full signed bundle for a
    commit: its `changes` row (signature + provenance) plus every `gate_results` DSSE envelope
    reported for that sha, most-recent-first per gate.
  - `adp_undo`: calls `core/undo.ts` directly, same semantics as the REST endpoint (only
    `proposal.merge` so far, refused if the branch moved since).
  - `adp_candidates_open` / `adp_candidates_select`: wrap the candidate-set data model
    (`core/candidate-sets.ts`, a `candidate_sets` table keyed to one `intent`). Opening a set
    creates the row; proposals join it by passing `candidate_set_id` at creation
    (`http-rest/proposals.ts`, the existing `POST .../pulls`, not a new endpoint) — fan-out is just
    N ordinary proposals sharing one `candidateSetId`. Selecting records the winning proposal id on
    the set; it doesn't close or merge the losing candidates, which stay exactly as open proposals
    an agent or human can still inspect.
  - Covered by `server/test/e2e-native-plane.test.ts` (workspace create/list/destroy against a real
    branch, evidence-bundle assembly from a real signed change + gate report) and
    `server/test/e2e-mcp.test.ts` — a real MCP `Client`/`Server` pair over the SDK's in-memory
    transport, the MCP server's real HTTP client hitting a real Fastify+Postgres instance: tool
    listing, workspace round-trip, evidence-after-op-log, history-query filtering, undo reverting a
    real merge, and candidate-set open/fan-out/select over two real proposals against one intent.
    `server/test/e2e-hooks.test.ts` covers history-query by path against a real pushed commit.
- ~~**Read-only web UI**~~ **done**: `server/web/`, a Vite + React + TypeScript SPA served as
  static assets by the same Fastify server at `/ui/*` (`@fastify/static`, `main.ts` — skipped with
  a log line if the app hasn't been built yet, so a fresh checkout's plain `npm run dev` still
  boots). No client-side URL routing — `App.tsx` navigates via in-memory state, since the whole
  point is one page a human opens, not a set of shareable deep links — so there's no
  history-fallback to wire up either. Calls the plain REST API (not GraphQL) via `src/api.ts`; a
  connect screen collects a token + owner/repo into `localStorage` (there's no login system to
  build against). Views: issues list + detail (with comments), pull requests list + detail
  (reviews, gate results for the head commit, files changed, an on-demand diff load), an evidence
  view (signed change provenance/signature + every DSSE gate attestation for a commit), and the op
  log with filters — the one interactive control granted per the plan of record ("op log with
  undo"): an **Undo** button on `proposal.merge` rows, calling the same `/api/adp` endpoint the
  MCP tool and a direct API caller would, with the result (or the server's refusal reason) shown
  inline. Candidate-set comparison, named in the original UI scope, still isn't built in the web UI
  — candidate sets now exist as a real data model and are reachable via REST/MCP (above), but the
  UI has no dedicated view for them yet, an honest gap rather than a blocker for M1 exit.
  - **Verification note:** this sandbox has no root and is missing the system libraries Chromium
    needs (`libnspr4`, `libnss3`, …), and neither jsdom nor happy-dom could execute the built Vite
    ES-module bundle — so this was *not* visually confirmed in a real rendered browser. What was
    verified: a clean `tsc --noEmit`, a clean `vite build`, static-asset serving confirmed over real
    HTTP, and — seeding a real repo/issue/PR/review/gate-report/merge through the actual running
    server — every endpoint the UI calls hit directly and confirmed to match the TypeScript
    interfaces in `api.ts` exactly, including a real merge-undo round trip. Worth an actual
    browser check before relying on this for anything but development.
- ~~**History query (full, by path), candidate sets**~~ **done** — see the op-log and MCP bullets
  above. The one remaining gap is UI-only: the web UI has no candidate-set comparison view.

**Exit:** §2.1 passes as a scripted E2E driven by a real unmodified agent — plus one addition, now
**met**: a push containing a seeded secret is blocked at the wire with a typed error. All of M1c's
differentiators, including the two items that were outstanding as of 2026-07-26 (history-query by
path, candidate sets), are now implemented and covered by real e2e tests — **M1 is complete.**

### M2 — Adoption + trust ramp *(revised 2026-07-26; amended 2026-08-01 per [`m2-readiness-review.md`](m2-readiness-review.md))*
**Mirror mode — ✓ landed** (bidirectional GitHub sync — ADP alongside a repo that stays on GitHub;
the single biggest adoption lever and cheap: push mirror + webhook ingest). **Outbound webhook
emitter — ✓ landed:** `core/webhooks.ts` (HMAC-SHA256 signing, GitHub's own `X-Hub-Signature-256`
header shape, 3-attempt retry with backoff, then logged rather than queued) + `POST/GET/DELETE
/api/v3/repos/:owner/:repo/hooks` + emission wired at push (`http-git/hooks.ts`), PR open/merge (REST
and GraphQL), and gate report. **`adp` CLI — ✓ landed:** `cli/`, a new top-level package (first CLI
in the repo, zero runtime dependencies). Thin REST wrapper — `login`, `repo mirror`, `gate report`,
`pr list`, `pr merge` — reusing the same bearer-token auth every other client already uses.
`~/.adp/config.json` or `ADP_SERVER_URL`/`ADP_TOKEN`, same override shape as `gh`'s own
`GH_HOST`/`GH_TOKEN`.
`conformance/` published against `spec/`. GraphQL coverage widened from measured real traffic —
which makes **API-traffic telemetry a named prerequisite**, not an optimization: nothing measured
traffic before this. **✓ landed:** `core/telemetry.ts` + `GET /metrics` (Prometheus text format) —
REST by route pattern/method/status, GraphQL by root field/operation type/outcome. The coverage
*widening* itself still waits on real traffic accumulating against a running instance.
Plus the trust-plane ramp (§1.5 item 4):
- **Scanner-as-gate adapters — ✓ landed:** `adapters/` (new top-level package, standalone scripts —
  see `adapters/README.md` for the contract). Adapters never invoke the scanner; they translate output
  a scanner already produced (SARIF or its own JSON) and POST it to `.../gates`, same division of
  labor as the rest of the gate runner. **`wizcli`** (`adapters/wizcli/`) is the reference adapter —
  consumes a SARIF file from `wizcli`'s own `--sarif-output-file` flag (verified against Wiz's public
  docs; the scan subcommand/policy flags themselves are account-specific and unverifiable without a
  Wiz license, so left to the caller). **`osv-scanner`** (`adapters/osv-scanner/`) is the second
  implementation, deliberately consuming its *native* JSON rather than SARIF, proving the interface
  generalizes. Both parsers are tested against fixtures captured from a real, live `osv-scanner`
  binary (downloaded and run against a lockfile with known CVEs) — not synthetic data guessed to
  match the parser's own assumptions. That real run caught a live bug before it shipped: osv-scanner's
  own SARIF output marks genuine vulnerabilities `level: "warning"`, never `"error"`, which is why the
  SARIF adapter's default fail threshold is `warning`, not `error` (configurable via `--fail-level`).
- **Dependency admission v0 — ✓ landed:** `core/dependency-admission.ts` + `POST
  .../dependency-admission`, a typed gate (three-way `admit`/`quarantine`/`block` per package) a
  lockfile diff reports into. One integration point covers both named checks: OpenSSF's Malicious
  Packages project publishes directly into OSV.dev in OSV format (`MAL-` prefixed ids), so the same
  `POST api.osv.dev/v1/query` call returns both ordinary CVE/GHSA advisories and malicious-package
  reports — confirmed against the live API (queried a real reported-malicious npm package,
  `sdxcode1@9.9.9` / MAL-2025-2155). Registry existence + an age/cooldown window are real for npm
  (`registry.npmjs.org`) in v0; other ecosystems are honestly reported as unverified rather than
  silently admitted. `quarantine` reports gate status `pending`, which `gates_green`
  (`core/gate-results-lookup.ts`) already treats as not-green — a repo opts in by naming
  `dependency-admission` in `adp.yaml`'s `gates:`, no land-policy code change needed.
- **SBOM per land — ✓ landed:** `core/sbom.ts` generates a real CycloneDX 1.5 SBOM (npm lockfiles
  only in v0, same scope `dependency-admission.ts` settled on) and records it as an ordinary
  `gate_results` row (`name: "sbom"`) after every successful merge, both REST and GraphQL paths —
  the exact same receiving-and-attestation shape as a gate report, so it surfaces through the
  existing evidence bundle (`core/evidence.ts`) with no new read endpoint.
  `predicateType: "https://cyclonedx.org/bom"` is the documented in-toto convention (the same shape
  `cosign attest --type cyclonedx` produces), not an ADP-specific type. Purl construction for scoped
  npm packages (`@scope/name`) is verified against purl-spec's own worked example — an earlier draft
  double-encoded the `@scope/name` separator into an invalid purl, caught before shipping.

Plus the **scale hygiene forced by mirror mode** (added 2026-08-01 — mirroring imports real GitHub
repos with real histories, which turns these from M5 speculation into M2 correctness bugs; details
and file references in the readiness review §2). **✓ landed** (all five items):
- **Chunked post-receive recording:** the 500-commit-per-ref-update cap in
  `server/src/http-git/hooks.ts` must chunk or queue, never truncate silently — a silent hole in
  the provenance record is the one failure mode this product cannot have. Done for an existing
  branch receiving a >500-commit push (paged via `git log --skip`, batched into one transaction per
  page instead of one per commit). **Known residual gap, left for mirror mode itself (PR4):** a
  brand-new branch still records its tip commit only (the pre-existing shortcut, `hooks.ts`'s
  `oldSha === ZERO_SHA` case) — correct for an ordinary new local branch, wrong for a *first* mirror
  import, which needs its own bulk-import path rather than reusing the push hook as-is.
- **Secondary-index pass:** `changes (repo_id, git_sha)`, `gate_results (repo_id, git_sha, name)`
  composite indexes, and `operations` gained a real `repo_id` column (indexed) replacing the
  `target` LIKE-prefix scan — every one of these hot paths was a sequential scan before.
- **Pagination on unbounded list endpoints** (`GET /pulls`, `GET /git/refs`), GitHub-shaped
  (`per_page`/`page`) — a compat-fidelity gain as well as a scale fix.
- **Merge-method fidelity:** real merge-commit and squash support on both merge paths
  (`server/src/core/merge.ts`, shared by REST and GraphQL) — `merge_method`/`mergeMethod` is now
  read and honored; default changed from silent fast-forward to a real merge commit, matching
  GitHub's own default. Rebase-merge stays a typed 422, not implemented.
- **Land-policy TOCTOU:** policy is now re-evaluated immediately before the ref CAS on both merge
  paths, narrowing (not closing — git and Postgres aren't one transaction) the window a superseding
  gate result could land in.

**What mirror mode means for GitHub Actions** (clarified 2026-08-02 — this is the most frequently
misread part of the milestone). "Support Actions" means three different things with three different
answers:

| Meaning | Answer | Why |
|---|---|---|
| Actions runs on GitHub; results flow into ADP as evidence | **Yes — every feature, for free** | The repo stays on GitHub. GitHub's runners execute the workflows exactly as before; ADP ingests `check_run`/`workflow_run`/`status` webhooks into `gate_results`. Marketplace actions, matrix builds, self-hosted runners and OIDC all work because none of them were touched |
| ADP serves the Actions *API* (`gh run list`, `gh run view`) | **Read-only, for mirrored repos, at M2** | Proxied upstream — see the passthrough below. Non-mirrored repos and all write paths keep the `404` |
| ADP executes workflow YAML itself | **Never** | §2.5 cut list. An Actions clone is a multi-year trap |

The first row is why mirror mode is described above as *the single biggest adoption lever and cheap*.
It is also a cost argument: the expensive part of CI stays on GitHub's runners and never appears on
an ADP bill — see [`hosting-cost-estimate.md`](hosting-cost-estimate.md).

**Runners required for Actions: none.** ADP's gate runner (§4.2) is a different component for a
different job — `adp.yaml` `image + commands`, explicitly *"not a workflow engine"* — serving repos
that are **not** on GitHub, plus the scanner adapters above. At M2 its entire load is scanners over
changed files: bursty and small, nothing resembling a CI matrix.

**Read-only Actions passthrough — ✓ landed 2026-08-03** *(promoted from candidate to committed
2026-08-02)*. Both halves shipped: ingest (`core/actions-ingest.ts`, wired into the mirror webhook
by `X-GitHub-Event` dispatch) and the relay (`http-rest/actions.ts`). Exactly-once is enforced by a
partial unique index on `gate_results (repo_id, external_id)` rather than by application code, so a
redelivery cannot write a second attestation even if a caller forgets to check.
In mirror mode the upstream repo is on GitHub by definition, so ADP proxies read-only Actions
endpoints upstream instead of returning `404`, making `gh run list` and `gh run view` work against
`GH_HOST=adp` for mirrored repos. This is a passthrough, not an implementation: it adds no workflow
engine, is mirror-mode-only by construction, and closes a visible hole in the §2.1 "unmodified agent,
zero config" success test — an agent that can see its own CI results is the whole point of the
evidence plane.

- **Scope:** `GET .../actions/runs`, `.../actions/runs/{id}`, `.../actions/runs/{id}/jobs`,
  `.../actions/workflows`. Read-only — no dispatch, no re-run, no cancel. Writes stay `404`, because
  a write path would make ADP responsible for an execution model it deliberately does not have.
- **Non-mirrored repos keep the `404`**, with the §2.4 body naming the ADP equivalent. The
  passthrough is a property of *being mirrored*, not of the endpoint.
- **Relay, do not record** *(this resolves the dedup question that was open here)*. Webhook ingest
  already writes the authoritative evidence row when the run completes; a proxy that also recorded
  would produce two provenance records for one CI run and leave the `operations` log describing a
  read as though it were a state change. The proxy is a read-through view for agent convenience —
  the evidence plane has exactly one writer, which is the ingest path. Reversible if a case appears
  for recording proxied reads, but the default has to be one writer.
- **Failure mode:** upstream unreachable or rate-limited returns `502` with a body naming the cause,
  never a synthesized empty run list — an agent that believes CI passed because the proxy fabricated
  silence is the worst outcome available here.

**At kickoff — done 2026-08-02.** Both open questions in
[`environments-plan.md`](environments-plan.md) §5 are answered there (SIGNING_KEY custody plus the
retired-key trust model in §5.1; dev-instance ownership and retirement in §5.2), and the dev
environment they blocked is built: Terraform in [`infra/dev/`](../infra/dev/), runbook in
[`infra/README.md`](../infra/README.md). The short version of the trust-model half: a *retired*
key's evidence stays valid, a *compromised* key's does not, and DSSE's existing `keyid` field
(`server/src/core/dsse.ts`) means the envelope format needs no migration to support that.

**Exit:** an existing GitHub repo gets ADP workspaces + evidence without migrating; a `wizcli`
gate posts findings as signed evidence on a proposal; a lockfile diff adding a known-malicious
package is refused with a typed verdict the agent can act on. Added 2026-08-01: a mirrored repo
with a >500-commit history has a signed change recorded for every commit; `gh pr merge --merge`
and `--squash` produce GitHub-equivalent history. Added 2026-08-02: against a mirrored repo,
`gh run list` returns the upstream runs and a non-mirrored repo still returns the self-describing
`404` — and exactly one evidence row exists per completed upstream run, proving the proxy relays
without recording.

### M3 — Fleet and differentiation (weeks 16–20) *(amended 2026-08-01 per [`m2-readiness-review.md`](m2-readiness-review.md); clarified and sequenced 2026-08-03 per [`m3-readiness-review.md`](m3-readiness-review.md), which carries the executable work plan)*
50-way fan-out orchestration over candidate sets. Cross-harness checkpoint/resume (session state as a
first-class ADP object — the §e demo). Statistical land criteria v0: flaky-gate quarantine,
confidence-interval gating — the A8 contribution. Benchmark harness published (tokens / tool calls /
error rate / wall clock: GitHub+`gh` vs ADP-MCP vs ADP-via-`gh`) — note this now measures all three
arms for free, because both planes exist. Added 2026-08-01, two further benchmark arms — the
merge-bottleneck thesis currently has zero first-party measurement, and the M5 gates need telemetry
to cite:
- **Merge-contention arm:** land throughput and retry behavior under N concurrent agents targeting
  one branch, including conflict-rate telemetry (ForgeMark-comparable; feeds A17 and the M5
  speculative-batching gate).
- **Fan-out-vs-serial arm:** cost and outcome comparison of K parallel candidate-set attempts vs
  one serial checkpoint-resume session on the same tasks (feeds A16).

**Clarified 2026-08-03** (no scope added; the M3 review's §2 explains each):
- **D1 is satisfied by serial land, not speculative batching.** D1's own text says "speculatively
  batch", but speculative merge batching is an M5 item gated on M3/M4 telemetry — the telemetry the
  merge-contention arm above exists to produce. Read literally, the exit criterion would require the
  thing it is meant to generate evidence for. Serial land (§2.5) satisfies every observable D1
  describes, and the M5 gate stays shut.
- **"50-way fan-out orchestration" means completing the candidate-set lifecycle**, not building it:
  the data model landed in M1c. What is missing is resolution — real selection policies
  (`manual`/`first_green`/`best_score`), land-on-select through the existing `core/merge.ts` path,
  and candidate-set-scoped reclamation of losing workspaces. Losers stay queryable; only their refs
  are reclaimed.
- **The candidate-set comparison view** (the one gap M1 closed out with) is M3 scope — D1's stated
  payoff is that history view.
- **Sessions and checkpoints** are specified in the review: a checkpoint is signed evidence (DSSE,
  same shape as a gate result) whose signature is verified *at resume*, resume creates a new session
  linked by `resumed_from_session_id` and `parentOp`, and per **A18** sessions hang off `operations`
  and `changes` — never off `proposal`.
- **Statistical gating** uses a Wilson score interval lower bound (not the normal approximation,
  which is wrong in the permissive direction at the small run counts this will see), derives flake
  statistics from `gate_results` rather than a second table, and treats quarantine as always visible:
  a gate that silently stops mattering is worse than a flaky one.
- **Benchmark split:** the merge-contention arm is deterministic, needs no model, and is CI-enforced.
  The three-way cost comparison and fan-out-vs-serial arms are agent-backed and run out of band,
  publishing captured run records so a reader can re-derive every number without re-running an agent.

**Added 2026-08-03 — M2 debt paid first.** M2's exit criterion "a mirrored repo with a >500-commit
history has a signed change recorded for every commit" was met only for incremental pushes: a *first*
mirror import took `change-recorder.ts`'s brand-new-ref shortcut and recorded the tip commit alone,
and the test covering the criterion pushed a root commit first to step around that path. M3's own
benchmarks run against mirrored repos, so this is a prerequisite of the milestone's measurements
rather than leftover tidying. Two minor M2 defects ride along: webhook CRUD never wrote to the
operation log (M4's audit-log export is a projection of that table), and the Actions passthrough
relayed for mirrors marked disabled.

**Progress (2026-08-03).** Landed so far:
- **M3-0 — M2 debt paid — ✓ landed.** First-import provenance (`core/change-recorder.ts` now walks
  the full history on a new ref and lets dedup decide where to stop); webhook CRUD writes to the
  operation log; the Actions passthrough honours a disabled mirror.
- **M3-1 — schema — ✓ landed.** `sessions`, `checkpoints`, and candidate-set resolution state
  (migration `0012`).
- **M3-2 — candidate-set lifecycle — ✓ landed.** `manual`/`first_green`/`best_score` selection
  policies, land-on-select through the shared land path, and reclamation of losing workspaces.
  Gate reports gained an optional typed `score` carried into the signed predicate, so `best_score`
  ranks on attested evidence rather than an out-of-band assertion. The land sequence itself moved to
  `core/land.ts` and is now shared by the REST route, the GraphQL mutation, and candidate resolution
  — it had been duplicated across the first two, and resolution would have made three.
- **M3-3 — sessions and checkpoints — ✓ landed.** DSSE-signed checkpoints whose signature covers a
  digest of the opaque harness state; resume verifies both and refuses on mismatch; lineage via
  `resumed_from_session_id` plus `parentOp`. Four MCP tools, `spec/schemas/session.json` and
  `checkpoint.json`.
- **M3-4 — statistical land criteria — ✓ landed.** `gates_confident` on a Wilson lower bound, and
  visible flake quarantine recorded as `gate.quarantine` at the point it permits a land.
- **M3-5 arm 1 — merge contention — ✓ landed and run.** `bench/`, deterministic and CI-enforced.
  First first-party measurement of the merge-bottleneck thesis: total attempts track N(N+1)/2
  exactly at N = 2, 4, 8, 16 — quadratic work for linear lands, with conflict rate converging on
  (N−1)/(N+1). See [`bench/report/merge-contention.md`](../bench/report/merge-contention.md).
- **M3-6 — candidate-set comparison view — ✓ landed.** `server/web/`, plus the list endpoint and the
  per-candidate score/gate projection the view needs. Losing candidates are shown alongside the
  winner with the evidence that decided against them — a view showing only the winner would make a
  50-way fan-out indistinguishable from a single proposal, which is the thing GitHub cannot express.

Outstanding: **M3-5 arms 2 and 3** — the agent-backed three-way cost comparison and the
fan-out-vs-serial arm. Both need a real agent burning real tokens, and arm 2 additionally needs a
real GitHub repo and PAT, so they run out of band rather than in CI. The benchmark is published with
arm 1 complete and these two reported as not run.

**Exit:** D1 and D2 from the prototype doc are demonstrable; benchmark published with methodology.
Added 2026-08-03: a repo mirrored in from GitHub with a >500-commit history has a signed change per
commit **on first import**, proven by a test that mirrors rather than one that pushes over HTTP; a
session checkpointed under one harness identifier and resumed under another yields one signed,
lineage-linked history in a single op-log query; a gate that fails intermittently is quarantined
visibly rather than blocking or silently passing.

### M4 — Multi-tenant hosted preview (weeks 21–26)
Org/user model, OIDC login, scoped tokens, quotas and GC. Managed Postgres + object store.
The instance policy floor generalizes to the org policy plane (org ∧ repo resolution, policy
changes as signed reviewable changes, fleet kill switch) and the named procurement checklist
lands here: SSO/SCIM, audit-log export (a projection of `operations`, not a second system),
org policy console.
Backup/PITR with an **executed** restore drill. Runner pool isolation. Observability dashboards.
Docs, quickstart, self-host artifacts (image + compose + helm).
**Exit:** external users can sign up and run a real workload; restore drill completed.

### M5 — Substrate hardening (evidence-gated, open-ended)
Only if measurement demands: jj-derived change engine with first-class conflicts; VFS lazy
materialization; speculative merge batching; pluggable storage backends (Lore evaluation, A3);
per-path ACLs; structural merge. **Each requires a written justification citing M3/M4 telemetry.**

---

# Part 4 — Infrastructure

## 4.1 Shape

One public monorepo, one deployable service plus a runner, no Kubernetes.

```
adp/
  spec/         OpenAPI + JSON Schemas (change, evidence, provenance, operation) ← durable artifact
  server/       modular monolith
    http-git/   git-http-backend proxy + auth
    http-rest/  /api/v3 (GitHub-compatible) + /api/adp (native)
    http-gql/   /api/graphql — GitHub SDL + partial resolvers
    mcp/        native-plane MCP server
    core/       domain: changes, proposals, reviews, gates, evidence, operations
    db/  auth/  gates/
  runner/       container gate executor (Postgres job queue)
  cli/          adp CLI (M2)
  adapters/     scanner-as-gate adapters — wizcli, osv-scanner (M2)
  bench/        benchmark harness — arms, captured run records, derived report (M3)
  web/          read-only supervision UI
  conformance/  black-box HTTP suite + gh record-replay ← future multi-vendor artifact
  deploy/       Dockerfile, docker-compose.yml, .env.example, Caddyfile, helm/ (M4)
```

Monolith with enforced internal module boundaries: the MVP's risk is surface breadth, not scale.
Boundaries preserve the option to split; a service mesh at week 3 does not.

## 4.2 Components

| Component | Choice | Why |
|---|---|---|
| **Runtime** | Node 22 LTS, TypeScript strict, ESM | Locked. Fastest iteration on surface breadth |
| **HTTP** | Fastify | Fast, schema-first — route schemas generate from the same JSON Schemas as `spec/` |
| **GraphQL** | `graphql-js` + GitHub's published SDL, partial resolvers (§2.4 Tier 3) | Correct validation without reimplementing the schema |
| **Git storage** | Bare repos on one volume; all plumbing by invoking the real `git` binary as a subprocess | 100% fidelity, free. No isomorphic-git/nodegit edge cases. Behind a `GitBackend` interface for later |
| **Git transport** | `git http-backend` (CGI) proxied behind auth middleware | The reference implementation of the wire protocol, already installed |
| **Database** | PostgreSQL 16, Drizzle (migrations + typed queries) | Transactional spine |
| **Job queue** | `pg-boss` (Postgres-backed) | No Redis. One stateful dependency is enough, and gate jobs want transactional enqueue alongside the change record |
| **Object store** | S3-compatible: MinIO self-hosted, Cloud Storage hosted (its XML API keeps the same client). Content-addressed keys `sha256/<hash>` | Gate logs, junit XML, evidence payloads, trajectories. Content addressing gives dedup and makes A9 sealed payloads natural later. Staying S3-compatible rather than adopting a GCS-native client is what keeps the self-host path real |
| **Gate runner** | Separate process, Docker/Podman. Reads `adp.yaml` (`image`, `setup`, `gates:[{name,run,weight}]`), materializes a checkout, runs commands, uploads logs+junit, posts a check-run | Not a workflow engine. No matrix, no marketplace, no DAG |
| **MCP** | Official TS SDK, streamable-HTTP, bearer auth, same process | MCP is a projection of the same domain layer, not a second system |
| **Web UI** | Vite + React SPA, read-only, served as static assets. Views: repo, history graph, change detail (intent/diff/evidence/provenance), proposal, candidate-set comparison, op log with undo, gate logs | Humans supervise, agents act. Deliberately small |

**The one hard invariant:** every mutation writes its state change **and** its `operations` row in a
single Postgres transaction. That invariant *is* the op log, *is* the audit log, and is what makes
undo possible. It is free at commit 1 and impossible to retrofit.

## 4.3 Data model

```
repos, refs_cache
workspaces        (repo, base_ref, branch, owner_identity, state, ttl)
intents           (title, body, source: issue|task|api, parent)
issues, comments
changes           (repo, git_sha, intent_id, workspace_id, provenance_id, signature)
proposals         (repo, head_change, base_ref, state, candidate_set_id?)
candidate_sets    (intent_id, selection_policy, selected_proposal_id?)
reviews           (proposal, reviewer_identity, state, body, annotations jsonb)
gate_runs, evidence (proposal, change, results, artifact_refs, verdict, land_decision)
identities        (kind: human|agent, principal, harness, model, session_id, pubkey?)
operations        ← append-only spine: (actor, verb, target, before, after, parent_op, inverse)
node_ids          (global-id mapping for GraphQL Node resolution)
```

`operations` is the keystone. Everything else can be added later; it cannot.

## 4.4 Auth and identity

- **Human tokens:** opaque PATs, argon2id-hashed at rest, scopes `repo:read|write`, `admin`.
  Served back through `X-OAuth-Scopes` so `gh auth status` reports correctly.
- **Agent identity tokens:** minted per session, short TTL, carrying
  `(principal, harness, model, session_id, repo, workspace)`. **This tuple is the MVP's answer to
  A9's "what, cryptographically, is an agent identity"** — provenance-bearing, delegation-shaped,
  revocable, and honest about being weaker than per-agent keys.
- **Transport:** bearer for REST/GraphQL/MCP; token-as-HTTP-password for git — identical to how
  agents already authenticate to GitHub, so zero new agent behavior.
- **Signing:** server-held Ed25519 over the canonicalized (change, evidence, provenance) tuple.
  Schema admits per-agent keys and sealed payloads later; MVP implements neither.
- Deferred: OIDC/SSO (M4), per-path ACLs (M5).

## 4.5 Hosting

**MVP: one VM + docker compose, on GCP** *(provider decided 2026-08-01; sized and priced
2026-08-02)*. A GCE **`n2-standard-4` — 4 vCPU, 16 GB** — with one balanced persistent disk
(200 GB), at **~$113/month** effective after automatic sustained-use discount, ~$125–165 all-in with
disk, address and egress. Caddy in front for automatic TLS. **Compose runs server, Postgres,
Caddy** — the three services in [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) today.
An object store (MinIO) and a gate runner join it when the features that need them land; neither is
in the committed stack, and §4.2's object-store row and §4.6's `OBJECT_STORE_*` / `RUNNER_*` env
vars describe that intended shape rather than what boots today *(corrected 2026-08-02 — this
sentence previously named all five as though they already ran)*.

*This replaces an earlier "`n2`/`c3-standard`, 8–16 vCPU, 64 GB", which was never measured against a
workload and priced at $410–590/month.* Full derivation, the AWS comparison and the levers are in
[`hosting-cost-estimate.md`](hosting-cost-estimate.md). Three things that estimate settled:

- **Right-sizing is the entire saving** — $270–450/month, dwarfing every discount mechanism. The
  scale envelope this has to serve is stated in [`m2-readiness-review.md`](m2-readiness-review.md)
  and is explicitly not Chromium-class; sizing should match that envelope, not the aspiration.
  Revisit at M4 *with measurements*, which is the same instruction as before but now with a number
  to beat.
- **N2 over E2, deliberately.** `e2-standard-4` lists 31% cheaper, but sustained-use discounts apply
  to N2 and not to E2/C3/C4/N4/N4A, which cuts the real gap to ~14% — and N2 buys non-shared CPU,
  which matters because git pack generation is this system's CPU spike.
- **No committed-use discounts yet.** They are worth 37%/55%, but the shape changes at M4 when
  runners split off (see the trigger note below) and Postgres becomes managed. A one-year commitment
  on the wrong shape is worse than list.

Defense: the workload is stateful (git repos on disk), needs a Docker socket for gate execution, and
has one user (us) for weeks. Kubernetes, Cloud Run, and serverless all fight at least one of those —
the shape of the answer is unchanged by the choice of provider. It deploys with
`git pull && docker compose up -d` and rebuilds from `deploy/` in ten minutes. Revisit at M4, not
before.

**On the provider trade.** Choosing one provider for every rung was a deliberate trade of money for
operational simplicity, argued in [`environments-plan.md`](environments-plan.md). The 2026-08-02
pricing check quantified it and the trade holds comfortably: like-for-like AWS lands **within ~10%
in either direction** — `c3-standard-8` and `m7i.2xlarge` are both $0.4032/hr, to the cent — with
GCP ahead on sustained-use discounts, Arm and managed Postgres, and AWS ahead on block storage and
egress. A 10% compute delta does not buy back two billing relationships, two IAM models and two sets
of operational habits. **The provider decision survived the pricing check; the sizing did not.**

**TLS and hostname matter more than usual here:** `gh` only takes the GHES `/api/v3` + `/api/graphql`
path for a non-`github.com` host, and expects HTTPS. A real DNS name with a real certificate is a
week-1 requirement, not a polish item.

**When the runner host must split from the API host — the trigger is a capability, not a milestone**
*(added 2026-08-02)*. The M4 posture below puts gate runners on a separate pool, which is right but
dates the split to the wrong event. The precise trigger is **the change that first makes `adp.yaml`
executable** — today `server/src/core/repo-policy.ts` parses only gate *names* and land
requirements, there is no `image` or `run` key, and no executor exists anywhere in the tree (no
Docker socket, no `dockerode`). Nothing can execute, so there is nothing to escape from, and
colocation is currently safe.

The moment `adp.yaml` can name an image and commands, the box is running **arbitrary
repo-specified code next to a mounted Docker socket** — which is root-equivalent on the host. On a
colocated box that code shares a machine with Postgres and with `SIGNING_KEY`, and `SIGNING_KEY` is
the root of the entire provenance claim: a gate that can read it can forge evidence, which is the
one failure this product cannot absorb. **Split the host in the same change that ships the
executor**, whichever milestone that lands in.

M2's scanner adapters sit between the two states and do not trip the trigger: `wizcli` and
`osv-scanner` are chosen binaries rather than repo-supplied code. They do parse untrusted repo
content, so the exposure is parser vulnerability, not arbitrary execution — real, materially
smaller, and adequately handled by the container limits in §4.7 on a single box.

**M4 hosted posture:** Cloud SQL for PostgreSQL with PITR, Cloud Storage for artifacts, the git
volume on a persistent disk with scheduled snapshots, and gate runners on a **separate** managed
instance group — runners execute untrusted code and must never share a host with the API. Each of
these must have a self-host equivalent in `deploy/` — Postgres and a volume are there today, and the
object store's MinIO equivalent lands with the object store itself. That constraint is what keeps
"hosting is a convenience, never a license lever" true rather than aspirational, and it cuts both
ways: **a managed service may not ship in the hosted posture before its `deploy/` equivalent
exists**, or the self-host path silently becomes second-class.

**Environments below production** — a long-lived dev instance (forced by M2's inbound webhooks,
which a laptop cannot receive) and a staging instance (forced by M4's *executed* restore drill) —
are planned separately in [`environments-plan.md`](environments-plan.md). That document is
additive to this section, not a replacement: the single-VM production posture above stands, on
GCP for every rung.

## 4.6 Config

- **Server:** 12-factor env vars validated against a Zod schema **at boot, fail fast**.
  Validated today (`server/src/config.ts`): `DATABASE_URL`, `GIT_ROOT`, `SIGNING_KEY`, `PUBLIC_URL`,
  `PORT`, `GIT_MAX_PACK_BYTES`, `LAND_POLICY_FLOOR`. Planned, arriving with the features that need
  them: `OBJECT_STORE_*`, `RUNNER_*`. `deploy/.env.example` is the documentation.
- **Repo policy:** `adp.yaml` at repo root, versioned with the code — gates, land policy
  (`require: [gates_green, one_approval]`), risk tiers by path glob, workspace TTL. Policy-as-code
  in the repo, not in a database, so policy changes are themselves reviewable changes.
- **Migrations:** Drizzle, forward-only, run on boot behind a Postgres advisory lock.

## 4.7 Operations

| Concern | MVP approach |
|---|---|
| Logging | Structured JSON to stdout (`pino`); `docker compose logs`. No log platform until M4 |
| Tracing/metrics | OpenTelemetry SDK wired from commit 1, exporter off by default. Cheap now, impossible to retrofit, and it is the sibling of the evidence story |
| Health | `/healthz` liveness; `/readyz` checks db + object store + git volume |
| Backup | Postgres nightly `pg_dump` + WAL archiving to object store. Git nightly `git bundle --all` per repo to object store — self-verifying and restorable with plain git. Object store versioning on |
| Restore | A documented, **actually executed** restore drill is an M4 exit criterion. Untested backups are not backups |
| Audit | The `operations` table. No second system |
| GC | Workspaces expire on TTL; garbage refs swept nightly. Git objects **never** pruned in MVP — cheap insurance for undo correctness |
| Runner isolation | Network-deny by default with an `adp.yaml` allowlist; no host mounts; no ambient secrets; CPU/memory/wall-clock caps. **Host separation is not optional once `adp.yaml` becomes executable** — a mounted Docker socket is root on the host, and `SIGNING_KEY` must not be on that host (§4.5) |
| Secrets | Env only. No repo-scoped secret store — avoids becoming a secrets-management product |

## 4.8 Licensing and neutrality

Apache-2.0 for everything, public from the first commit. Decide the boundary now to avoid the
Elastic/HashiCorp trap later: **spec, conformance suite, CLI, and server are Apache-2.0 permanently;
hosting is a convenience, never a license lever.** Neutrality is the entire thesis, and a future
relicense would destroy it retroactively.

---

# Part 5 — Verification

In order of authority:

1. **Scripted E2E — the definition of done, automated.** `deploy/` up → create repo → set the three
   env vars → an unmodified agent (Claude Code, no MCP config) is given a task → `git clone` →
   `gh issue view` → edit → push → `gh pr create` → gates run → `gh pr checks` green →
   `gh pr view` shows the typed review → `gh pr merge` → fresh `git clone` shows the commit → ADP UI
   shows intent, signed evidence, provenance, op log → `adp_undo` reverts the land.
   Runs in CI on every commit. **If this does not pass, the MVP is not done, regardless of feature
   count.**
2. ~~**`gh` conformance gate.**~~ **Done** (`server/conformance/run.sh`, M1b′ item 3): a pinned,
   real, unmodified `gh` binary driven through the target commands against a live server, in CI on
   every PR. **This gate is met.** Recording and replaying exact HTTP exchanges captured against
   production github.com — the original framing here — remains undone; it needs a real GitHub
   token in CI and is a larger investment than the definition-of-done gate itself calls for.
3. **Git fidelity suite.** clone / shallow / partial / fetch / force-push / `push --atomic` /
   large file, against the real `git` binary. Guards the one thing that must never break.
4. **Candidate-set demo test.** Fan out 10 workspaces on one intent, gates score all 10, select and
   land one; the other 9 are archived, queryable, and absent from `git log`. The differentiator gets
   its own test.
5. **API conformance suite** (`conformance/`): black-box tests asserting the `spec/` OpenAPI
   contract. The M0 investment that becomes the multi-vendor artifact at M2.
6. **Measurement harness (M3).** A fixed task suite run through an agent against (a) GitHub + `gh`,
   (b) ADP + `gh`, (c) ADP + MCP — recording tokens, tool calls, error rate, wall clock, and the
   distribution of endpoints actually requested. Publish regardless of result. This is simultaneously
   the A1 study, the A2 study, and the honest basis for widening GraphQL coverage. Adopt ForgeMark
   (Entire's open push-throughput benchmark) alongside it — a neutral third-party yardstick for the
   write path.
7. **Trust-plane suite (M1c/M2).** A push containing a seeded secret is blocked at the wire with a
   typed error the agent can act on — and the block is recorded in the op log; a lockfile diff
   adding a known-malicious or too-new package fails dependency admission with a typed verdict;
   every stored evidence bundle validates as a well-formed DSSE/in-toto attestation; a repo-level
   `adp.yaml` cannot loosen the instance policy floor.

---

# Appendix — Decisions and their consequences

| Question | Answer | What it changed in this plan |
|---|---|---|
| Primary success test | Unmodified agent, zero config | Compat plane became tier-1; MVP grew from ~7 to ~11 weeks; native MCP surface shrank from 16 tools to 8 (only what GitHub can't express); TLS + real hostname became a week-1 requirement |
| `gh` CLI compatibility | In the MVP | ~14 GraphQL operations added; "load GitHub's real SDL, partial resolvers" chosen to avoid the partial-shim failure mode; record-replay suite became the M1b exit gate; M1 explicitly sequenced so `gh` risk surfaces in week 8 with a fallback intact |
| Stack | TypeScript + Node | Fastify / Drizzle / graphql-js / pg-boss / MCP TS SDK; git via subprocess; supersedes the docs' Rust + gRPC + jj-lib + gitoxide |
| Build vs fork | Greenfield over plain git | Confirmed by research: forking Gitea/Forgejo would not have delivered `gh` compat (no GraphQL) while importing a human-workflow data model |

**Residual risks to watch, in order:**
1. GraphQL slice under-scoped — `gh` reaches for a field we don't back mid-trajectory. *Mitigation:
   real SDL so it's a resolver error not a validation error; record-replay suite; native fallback.*
2. GitHub ships agent-native primitives and moots the standard (A10). *Mitigation: `spec/` +
   `conformance/` from day one — the "become the conformance layer" fallback is cheap to hold open.
   (Materializing as of mid-2026: Agent HQ + a security-vendor-heavy agent-apps Marketplace — which
   raises the urgency of publishing `conformance/`, and validates gates-in-the-agent-loop as the
   contested ground.)*
3. Adoption requires being system-of-record for someone's source. *Mitigation: mirror mode at M2.*
4. Scope gravity toward the brief's full architecture. *Mitigation: §2.5 is the contract; M5 items
   each require written justification citing telemetry.*
5. Trust-plane scope gravity — the §f procurement checklist balloons into building scanners or a
   GRC product. *Mitigation: adapters only (brief v5 A13/A15); the bundled secret engine is the
   only first-party detector; compliance output is attestations, and report-rendering belongs to
   partners.*

Sources: [Cursor Origin](https://www.eesel.ai/blog/what-is-cursor-origin) ·
[GitHub agent apps](https://github.blog/changelog/2026-06-02-extend-github-with-agent-apps/) ·
[GitHub Copilot app](https://github.blog/news-insights/product-news/github-copilot-app-the-agent-native-desktop-experience/) ·
[Forgejo/`gh` GraphQL gap](https://github.com/IoTReady/forgejo-cli) ·
[cli/cli ghinstance](https://raw.githubusercontent.com/cli/cli/trunk/internal/ghinstance/host.go)
