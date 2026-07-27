# ADP — Agent Development-state Protocol

An open, neutral, agent-native substrate for version control and CI/CD: every change is a typed
transaction carrying **intent → diff → evidence → provenance**, cryptographically signed, with a
server-side operation log — behind a GitHub-compatible surface, so `git` and `gh` keep working
with zero configuration.

**Status (July 2026): working server, M1c mostly done.** The walking skeleton (M0), the core
domain loop, and GitHub-compat surface are implemented and CI-verified end to end: an
authenticated client can create a repo, `git clone`/`push` over smart HTTP (delegated to the
real `git http-backend`), file issues that become typed intents, record Ed25519-signed changes
with provenance, open PR-shaped proposals, attach typed reviews, and land merges under a
two-level land policy — with every mutation writing an append-only `operations` row in the same
transaction. GraphQL serves GitHub's real published schema with both queries and mutations, and
is validated against the real, unmodified `gh` binary in CI (`conformance/run.sh`). Real git
`pre-receive`/`post-receive` hooks auto-record changes on push and run push protection against
committed secrets. Gate results are DSSE-signed evidence bundles; a native MCP plane (8 tools)
and a read-only web UI sit alongside the compat surface; the operation log supports undo of a
landed merge. Not yet built: full history query by file path, candidate sets, and the wider
trust plane beyond push protection and evidence bundles. See the
[status ledger](docs/pragmatic_mvp.md#status-ledger) for the per-milestone view.

## What this is

Software development is shifting from one human on one branch to fleets of agents running many
concurrent, speculative attempts against a shared codebase. Git was designed for none of that: its
unit of work is the line-based patch, its conflicts halt automation, and its operations scale with
repository size rather than working-set size. Meanwhile every agent harness — Claude Code, Codex,
OpenHands, Cursor's agents — is privately reinventing the same version-control primitives
(checkpoint/rewind, session persistence, memory files, multi-workspace orchestration), each one
invisible to the repository's history and incompatible with every other harness.

ADP is a proposed open, neutral substrate for that world. Git compatibility is preserved
throughout — `git clone` keeps working.

The differentiating bet is not storage or the change model, both of which the market is rapidly
converging on. It is **binding context to verification evidence at merge time** — capturing *why* a
change was made and *how it was verified* in one signed record. Several well-funded efforts capture
provenance; none gate on it. Brief v5 extends the same admission-time architecture into a **trust
plane**: enterprise controls and supply-chain security (org-enforced policy, push protection at the
receive path, dependency admission, attestation-native evidence, scanner integrations such as Wiz
Code) — the procurement checklist enterprise adopters treat as mandatory.

## The documents

| Document | What it is |
|---|---|
| [`docs/agent-native-vcs-brief-v5.md`](docs/agent-native-vcs-brief-v5.md) | **The thesis (v5, public draft).** The case for a neutral agent-native substrate: the GitHub interface question, versioning beyond source, the competitive landscape, architectural tradeoffs, the agent-harness boundary, and — new in v5 — enterprise controls and supply-chain security as a trust plane (§f). Its appendix (A1–A15) states the open decisions honestly — each names the evidence that would change the position. Prior versions live in git history. |
| [`docs/pragmatic_mvp.md`](docs/pragmatic_mvp.md) | **The plan of record.** A critique of the concept plus a deliberately narrow MVP: the smallest system an off-the-shelf agent can use *instead of* GitHub, with everything complex deferred and defended. Includes the per-milestone status ledger and the next-milestone plan. |
| [`docs/server-stack-tutorial.md`](docs/server-stack-tutorial.md) | **Onboarding.** The server stack (Node/TypeScript, Fastify, Postgres/Drizzle, Caddy, Docker Compose) explained piece by piece, no prior familiarity assumed. |

New readers: start with the brief for the argument, then `pragmatic_mvp.md` for what is actually
being built, in what order, and why the scope is what it is.

## MVP in one paragraph

Set three environment variables. An unmodified coding agent — no MCP config, no code changes, no
knowledge that ADP exists — clones, reads an issue, edits, pushes, opens a PR, watches checks go
green, gets a typed review, and merges, entirely against an ADP server. A human then opens the web
UI and sees the intent, the signed evidence bundle, the provenance (harness / model / session), and
the operation log — and can undo the landed change. Full scope, cut list, milestones, and
infrastructure are in [`docs/pragmatic_mvp.md`](docs/pragmatic_mvp.md).

## Running it

The server (Fastify + Postgres + the real `git` binary) runs locally or via Docker Compose —
setup, bootstrap, and the three-tier test suite are documented in
[`server/README.md`](server/README.md). CI runs typecheck, build, migrations, the full test
suite (unit / integration / end-to-end, including a real clone→push→propose→review→merge cycle),
and the `gh` conformance gate — the real, unmodified `gh` binary driven against the live
server — on every pull request.

## `gh` CLI and API surface

`git` (clone/fetch/pull/push/ls-remote, including shallow/partial/force-push) is delegated to
the real `git http-backend` binary, so it's 100% fidelity, not listed below. For `gh`, "functional"
means the command does real work against ADP's domain model end to end; "shell" means it's callable
but returns an honest no-op, a partial result, or a clear "not supported" error rather than doing
nothing or crashing. Full endpoint/operation inventory: `docs/pragmatic_mvp.md` §2.4.

| `gh` command | Status | Notes |
|---|---|---|
| `gh auth status` | **Functional** | via `GET /`, `GET /user` |
| `gh repo view` | **Functional** | |
| `gh repo clone` / `gh repo create` | **Functional** | REST create + git clone |
| `gh issue create` / `list` / `view` / `close` | **Functional** | verified against the real `gh` binary in CI |
| `gh issue comment` | **Functional** | |
| `gh pr create` | **Functional** | verified against the real `gh` binary in CI |
| `gh pr list` / `view [--json]` | **Functional** | verified against the real `gh` binary in CI |
| `gh pr checkout` | **Functional** | resolves head ref, then a real `git fetch` |
| `gh pr diff` | **Functional** | REST `Accept: …diff`/`…patch` |
| `gh pr comment` | **Functional** | comments land as issue comments; PR conversation-tab comments aren't modeled as a separate subject yet |
| `gh pr review` | **Functional** | |
| `gh pr merge` | **Functional** | verified against the real `gh` binary in CI; gated by the two-level land policy |
| `gh pr close` / `reopen` | **Functional** | |
| `gh pr checks` | **Shell** | aggregate rollup state is real; per-check-context detail is an empty connection, not backed yet |
| `gh pr ready` | **Shell** | recorded as a no-op — every PR is ready-for-review from creation, no draft state exists |
| `gh api <endpoint>` | **Functional for the ~24 implemented Tier-2 endpoints** | unimplemented endpoints (search, Actions, releases, packages, orgs/teams, projects, branch protection, code scanning, Dependabot, notifications, gists, webhooks) return `404` naming the ADP equivalent instead of hanging or 500ing |
| `gh run *` / `gh release *` / `gh project *` / `gh search *` | **Not supported** | deliberately unimplemented; returns a clear error, not a shell |

## License

Apache-2.0 intended for all code, spec, and conformance suites; CC-BY for prose. The neutrality
claim is the entire thesis, so the licensing boundary is deliberately fixed up front: hosting is a
convenience, never a license lever.
