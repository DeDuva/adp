# ADP — the agent-native forge

ADP is a self-hosted, GitHub-compatible forge for AI coding agents. Keep using `git`, `gh`, and
existing CI integrations while ADP binds every change to its intent, agent provenance, approvals,
and signed verification evidence.

**Why ADP?** An agent saying “tests pass” is not proof, and the transcript that could show its
work is gone when the session ends. ADP keeps that context on the change itself, and refuses to
land a change that does not meet your evidence requirements.

[Try it](#try-it) · [How it works](#how-it-works) · [Self-hosting](docs/self-hosting.md)

**New here?** Start with the site — [what ADP is](https://deduva.github.io/adp/),
[why it exists](https://deduva.github.io/adp/why/), and
[the AI-native SDLC stage by stage](https://deduva.github.io/adp/sdlc/).

Apache-2.0 · TypeScript · Fastify · PostgreSQL · the real `git` binary for all plumbing.

---

## Try it

One command. It starts a throwaway ADP against an ephemeral PostgreSQL, then uses ordinary `git`
and an **unmodified `gh`** to clone, push, open a proposal, report a gate, and land the change —
narrating each step. Nothing is installed, no account is created, and everything is torn down when
you press Enter.

```bash
git clone https://github.com/DeDuva/adp.git && cd adp
make demo
```

It ends where the point is. The merge is **refused** while the change has no gate result and no
approval, and allowed once it has both. You then read the signed evidence bundle and the operation
log that record why.

Needs Docker and Node 22 (`make doctor` checks). Under five minutes.

<details>
<summary>Or run the full verification suite</summary>

Every tier, including conformance against the real `gh` binary and the browser-driven acceptance
walkthrough.
Minutes rather than seconds, and it proves the parts a demo skips:

```bash
bash scripts/dev/bootstrap.sh
make up && make test-all && make down
```
</details>

For a persistent instance, see [`docs/self-hosting.md`](docs/self-hosting.md); to run from source,
[Running it](#running-it).

---

## Why

Agents write most new code now, and the pattern is serial rather than a swarm: one capable agent
iterates against CI until it believes the work is done, then submits. Fan-out is reserved for hard
problems and fleet-wide remediation.

The belief is the problem. When the author decides when it's finished, the only oversight surface
is a test suite the author can see — and often edit.

Git was built for a different job. Its conflicts halt automation, and it records *what* changed
while discarding *why* and *whether anyone checked*. So when a change lands wrong, everything that
follows — revert it, validate it, continue it with a different model or harness — needs a record
that today exists only as a transcript in one vendor's format. Every harness privately reinvents
the same primitives: checkpoint and rewind, session persistence, workspace orchestration. None is
visible to the repository, and none can read another's.

ADP's bet is that the durable primitive is neither storage nor the change model, but **binding
context to verification evidence at merge time**. Plenty of systems capture provenance; the point
here is to make it enforceable — to turn the agent's belief into evidence someone else can check,
revert, or build on.

`git clone` keeps working throughout.

The long version, with the field data and how every other entrant scores:
**[Why ADP exists](https://deduva.github.io/adp/why/)**.

---

## How it works

ADP serves two APIs over the same data. One imitates GitHub, so tools you already have keep
working. The other exposes what GitHub has no equivalent for.

**The compatibility plane** is GitHub's surface: the git wire protocol, REST at `/api/v3`, and
GraphQL at `/api/graphql`. An off-the-shelf agent or CI tool uses it with no knowledge that ADP
exists. This is deliberately not an emulation layer bolted on top — the domain model *is* issues,
proposals, reviews, and merges, so GitHub's shapes project onto it directly.

**The native plane** at `/api/adp` (and over MCP) exposes what has no GitHub analogue: the
operation log, undo, evidence bundles, and workspaces.

### The change record

Pushing a commit produces a signed `changes` row binding four things together:

| Field | What it captures |
|---|---|
| **Intent** | the issue the work answers — filed as a typed intent, not free text |
| **Diff** | the git commit itself; git remains the store |
| **Evidence** | gate results for the commit, as DSSE-signed in-toto attestations |
| **Provenance** | the pushing identity, plus harness / model / session where supplied |

Schemas live in [`spec/schemas/`](spec/schemas/) (`change`, `evidence`, `provenance`, `operation`);
the REST surface is described in [`spec/openapi.yaml`](spec/openapi.yaml).

### Admission control

Two mechanisms run at the point where code enters the system, both as real git hooks invoked by
`git receive-pack`:

- **`pre-receive`** runs push protection. A bundled regex-plus-entropy secret scanner rejects the
  push at the wire with a typed error naming the line and pattern. Because `pre-receive` runs while
  pushed objects are still in git's per-push object quarantine, the hook computes its diff locally
  and ships the text to the server, rather than shipping shas the server cannot yet resolve.
- **`post-receive`** records a signed change per new commit, deduplicated by `(repo, sha)`. A
  commit that carries an `ADP-Intent` trailer — the intent's id, or the issue number as `#41` —
  is bound to that intent, and `ADP-Session` links it to a session; both are covered by the
  signature. The binding rides on `git` rather than on an API call, so it works from any harness,
  and a trailer naming something this repo does not have leaves the change unbound rather than
  failing the push.

Landing is governed by a three-level land policy: an instance floor (`LAND_POLICY_FLOOR`,
admin-owned), unioned with the org's floor, unioned with the repo's own `adp.yaml` — each level can
add requirements, never remove one. Both `gates_green` and `one_approval` are enforced identically
on the REST and GraphQL merge paths, and a malformed `adp.yaml` fails closed. Merges are
fast-forward only.

`one_approval` is **author-independent**: an approving review from the principal that authored the
proposal does not satisfy it, so an agent cannot clear the requirement that exists to check it by
approving its own work. Landing under this floor takes two principals.

```yaml
# adp.yaml, read off the base ref — as GitHub reads branch protection off the target branch
gates: [test, lint]
land:
  require: [gates_green, one_approval]
```

### Evidence, and who executes it

**The server receives and attests gate results; it never executes them.**
`POST /api/v3/repos/{o}/{r}/gates` signs and stores a result, `GET .../commits/{sha}/gates` lists
them, and they project onto the compatibility plane as `Commit.statusCheckRollup`. This is the same
division of labor as GitHub's Checks API: external systems report, the forge records and gates. No
first-party scanner is built, by design — the bundled secret engine is the only in-tree detector.

Execution is a separate process. The gate runner in [`runner/`](runner) polls
`/api/adp/gate-jobs/claim`, executes the job in an isolated container, and reports through the same
signed path any external reporter uses. It is a pure HTTP client — no server import, no database
credential, no signing key — and it belongs on its own host, because a mounted Docker socket is
root on that host. What the isolation actually guarantees, what proves it, and what it explicitly
does not claim are asserted in `server/test/` and the runner's own suite.

### Organizations

Repos live in orgs, and the org is the tenancy boundary. Repo access authorizes against the
caller's org on every plane alike — REST, git wire, GraphQL and `/api/adp` — and the matrix that
proves it is in `server/test/e2e-org-isolation.test.ts`.

An org carries four more things: its policy floor; a kill switch that refuses every land while set;
quotas on repos, concurrent workspaces, concurrent gate jobs and stored bytes; and an audit-log
export. That export is a projection of the operation log, not a second system. Org administration is itself audited: quota and
policy-repo changes write operations, and the policy floor is a file in a repo, so changing it
travels the same signed, reviewable path as code.

---

## Using it

Point `gh` at a running server. Note `GH_ENTERPRISE_TOKEN`, not `GH_TOKEN` — that is what `gh` reads
for any non-`github.com` host:

```bash
export GH_HOST=adp.example.com
export GH_ENTERPRISE_TOKEN=<token>
```

`gh` treats any unknown host as GitHub Enterprise Server and derives `https://HOST/api/v3/`, which
is where ADP mounts. The same is true for Octokit and most CI libraries.

Clone and push with a token as the git password:

```bash
git clone https://x-access-token:<token>@adp.example.com/<owner>/<repo>.git
```

### `git`

Smart HTTP is delegated to the real `git http-backend` CGI behind auth middleware, so
clone, fetch, pull, push, ls-remote, and shallow, partial, and force-push variants behave exactly as
git does. Delegating to git itself makes fidelity free. SSH is not served; sandboxed agents use
HTTPS and a token.

### `gh`

**Functional** means the command does real work against the domain model end to end. **Partial**
means it is callable and answers honestly, but some of what GitHub would return is not backed by
data here. The `issue create/view` and `pr create/view/merge` paths are driven by a real, unmodified
`gh` binary against a live server on every CI run.

| Command | Status | Notes |
|---|---|---|
| `gh auth status` | Functional | |
| `gh repo view` / `clone` / `create` | Functional | |
| `gh issue create` / `list` / `view` / `close` | Functional | |
| `gh issue comment` | Functional | |
| `gh pr create` / `list` / `view [--json]` | Functional | |
| `gh pr checkout` | Functional | resolves the head ref, then a real `git fetch` |
| `gh pr diff` | Functional | REST `Accept: …diff` / `…patch` |
| `gh pr review` | Functional | |
| `gh pr merge` | Functional | subject to the land policy; refuses with a typed 422 listing unmet requirements |
| `gh pr close` / `reopen` | Functional | |
| `gh pr comment` | Partial | stored as an issue comment; PR conversation comments are not a separate subject |
| `gh pr checks` | Functional | each gate result is a `StatusContext` — name, verdict, and a link to its evidence bundle. Not a `CheckRun`: that shape implies a workflow run, which ADP deliberately does not have |
| `gh pr ready` | Partial | recorded as a no-op — there is no draft state; PRs are ready from creation |
| `gh api <endpoint>` | Functional over the implemented surface | see below |
| `gh run` / `release` / `project` / `search` | Not supported | returns a clear error |

Unimplemented REST endpoints return `404` with a body naming the ADP equivalent. A broken call that
explains itself costs an agent one turn; a hang or a 500 costs it the trajectory. Not served: search,
Actions, releases, packages, orgs/teams, projects, deployments, branch protection, code scanning,
Dependabot, notifications, gists. Branch protection, code scanning, and Dependabot are absent *as
API surfaces* on purpose; their capabilities arrive natively through the land policy and push
protection instead of endpoint emulation.

GraphQL loads GitHub's real published SDL (`spec/graphql/github.graphql`) unmodified into
`graphql-js` and resolves only the fields ADP backs, including nine mutations. Everything else fails
as a resolver error, never a schema validation error — which is what keeps a partial implementation
from being worse than none, since `gh`'s queries validate against the real schema.

### Native plane

REST under `/api/adp`, and the same operations over MCP — 17 tools:

| Capability | REST | MCP tool |
|---|---|---|
| Operation log | `GET .../operations`, `.../operations/{id}` | `adp_op_log`, `adp_history_query` |
| Undo | `POST .../operations/{id}/undo` | `adp_undo` |
| Evidence bundle | `GET .../evidence/{sha}` | `adp_evidence_get` |
| Workspaces | `GET/POST .../workspaces`, `DELETE .../workspaces/{id}` | `adp_workspace_create`, `adp_workspace_destroy` |
| Candidate sets | `GET/POST .../candidate-sets`, `POST .../candidate-sets/{id}/select` | `adp_candidates_open`, `adp_candidates_select`, `adp_candidates_resolve` |
| Sessions and checkpoints | `POST .../sessions`, `.../sessions/{id}/checkpoints`, `.../sessions/{id}/resume` | `adp_session_start`, `adp_session_get`, `adp_checkpoint_create`, `adp_session_resume` |
| Trajectories | `POST .../sessions/{id}/events`, `GET .../runs/{id}/trajectory` | `adp_trajectory_append`, `adp_run_trajectory` |
| Runs and evals | `GET .../runs/{id}/stats`, `GET .../runs/compare` | `adp_run_stats`, `adp_runs_compare` |

The operation log is filterable by actor, verb, date range, and file path — path filtering resolves
the commit behind an operation and asks git which paths it touched. Undo currently covers reverting
a landed fast-forward merge, moving the base ref back by the same compare-and-swap the merge used;
it refuses if the branch has moved since, rather than silently discarding what landed after. Other
verbs return a 422 instead of a no-op that pretends to have worked.

A workspace is deliberately just a git branch with lifecycle metadata, not a new isolation
mechanism. Destroying one deletes the ref and marks the row destroyed, so the log stays complete.

**Candidate sets** are the one primitive here with no GitHub analogue: N competing solutions to a
single intent. A set is opened against an intent, proposals join it by passing `candidate_set_id`
at creation, and one is eventually selected as the winner — the fan-out/compare/pick shape a fleet
of agents actually produces, which a merge queue does not express.

The MCP server is a thin wrapper over these same REST endpoints, so behavior is defined in one
place rather than duplicated per protocol. Run it over stdio:

```bash
ADP_SERVER_URL=https://adp.example.com ADP_TOKEN=<token> npm run mcp
```

### `adp` CLI

A thin command-line wrapper over the REST endpoints above, for scripting and CI steps that would
otherwise be a raw `curl`. Lives in `cli/`, built and installed separately from the server:

```bash
cd cli && npm ci && npm run build
node dist/index.js login --server https://adp.example.com --token <token>   # writes ~/.adp/config.json
```

| Command | Wraps |
|---|---|
| `adp login --server <url> --token <token>` | writes `~/.adp/config.json` (or set `ADP_SERVER_URL`/`ADP_TOKEN`) |
| `adp repo mirror <owner>/<repo> --remote-url <url> --secret <secret> --credential <credential> [--direction outbound\|inbound\|both]` | `POST .../mirror` |
| `adp gate report --repo <owner>/<repo> --sha <sha> --name <name> --status <success\|failure\|pending>` | `POST .../gates` |
| `adp pr list --repo <owner>/<repo>` | `GET .../pulls` |
| `adp pr merge --repo <owner>/<repo> --number <n> [--method merge\|squash\|rebase]` | `PUT .../pulls/{n}/merge` |

### Web UI

A read-only React SPA served at `/ui/*` by the same server. It shows issues and pull requests with
their reviews, gate results, and diffs; the evidence view for a commit (signed provenance plus every
DSSE gate attestation); and the operation log with filters. Its one interactive control is an
**Undo** button on merge operations, calling the same endpoint the MCP tool and a direct API caller
would.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `GIT_ROOT` | — | directory holding bare repositories |
| `SIGNING_KEY` | — | any secret string; the Ed25519 key is derived via SHA-256 |
| `PUBLIC_URL` | — | externally reachable base URL |
| `PORT` | `3000` | listen port |
| `GIT_MAX_PACK_BYTES` | `500 MB` | bounds the git smart-HTTP request body only |
| `LAND_POLICY_FLOOR` | `gates_green,one_approval` | instance floor; empty string disables |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | — | OpenID Connect login. Both client values must be present or the routes do not mount at all |
| `OIDC_ALLOWED_DOMAINS` | empty | empty means **no auto-provisioning**: a verified account with no existing link is refused, not welcomed |
| `STORAGE_METER_INTERVAL_MS` | `600000` | how often each org's storage is re-measured; also the overshoot an org can achieve past its quota |

Auth is bearer tokens with `repo:read` / `repo:write` / `admin` scopes, enforced on every REST
route, the GraphQL endpoint, and the git route. Reads are private by default. Token lookup is by an
indexed `sha256` key, with scrypt verification doing the actual authentication.

---

## Running it

The server runs locally or under Docker Compose. Setup, bootstrapping the first token, and the
three-tier test suite are documented in [`server/README.md`](server/README.md).

```bash
cd server
npm install
npm run migrate
npm run dev
```

On a machine that has never seen this project, one command provisions it and one loop runs
everything against a throwaway database that is destroyed afterwards:

```bash
bash scripts/dev/bootstrap.sh          # toolchain, Docker, dependencies
make up && make test-all && make down  # bring up, run, tear down, assert clean
```

`make down` asserts the machine is clean rather than assuming it — no leftover containers, volumes,
server processes or temp directories. On Windows, `tools/win/Run-CleanTest.ps1` runs the same loop
inside a throwaway WSL distro and deletes it afterwards, so a full verification leaves nothing
behind at all.

**Self-hosting** is documented in [`docs/self-hosting.md`](docs/self-hosting.md): a Helm chart
([`helm/adp`](helm/adp)) and the Docker Compose path in [`deploy/`](deploy), what the two decisions
are that cannot be defaulted for you, and why the gate runner needs a node of its own.

CI runs typecheck, build, migrations against a fresh Postgres, the full unit/integration/e2e suite —
including a real clone → push → propose → review → merge cycle — and the `gh` conformance gate, on
every pull request. A separate clean-room workflow provisions a bare container from scratch and runs
the same loop, so the "brand new machine" path stays verified rather than assumed.

---

## Documents

| Document | What it is |
|---|---|
| [`docs/self-hosting.md`](docs/self-hosting.md) | Running your own instance: the Helm chart, the Compose path, what the chart refuses to guess and why, and where the sharp edges are. |
| [`docs/api-compatibility.md`](docs/api-compatibility.md) | What the contract version promises, and what a bump means for a generated client. |
| [`docs/server-stack-tutorial.md`](docs/server-stack-tutorial.md) | The server stack explained piece by piece, no prior familiarity assumed. |
| [`docs/observability.md`](docs/observability.md) | What is measured, what pages, and what to do when it does. |
| [`docs/ecosystem.md`](docs/ecosystem.md) | Who depends on ADP and how — the dependency graph, and what a change here requires elsewhere. Read this before changing the wire contract. |
| [`CHANGELOG.md`](CHANGELOG.md) | What shipped, per released version. |
| [`PLAN.md`](PLAN.md) | The backlog: what is left, in what order, and the open decisions. |

Contributing to ADP itself needs two more. [`AGENTS.md`](AGENTS.md) has the branch and review
conventions, the invariants that look wrong until you know why, and the commands that actually run.
[`docs/test-environment-automation.md`](docs/test-environment-automation.md) covers how the test
environment is brought up and torn down.

---

## License

[Apache-2.0](LICENSE) for code, spec, and conformance suites; CC-BY for prose.
