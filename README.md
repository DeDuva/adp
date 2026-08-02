# ADP — Agent Development-state Protocol

An open, neutral, agent-native substrate for version control and CI/CD: every change is a typed
transaction carrying **intent → diff → evidence → provenance**, cryptographically signed, with a
server-side operation log — behind a GitHub-compatible surface, so `git` and `gh` keep working
with zero configuration.

**Status (July 2026): working server, mid-M1.** The walking skeleton (M0) and the core domain
loop are implemented and CI-verified end to end: an authenticated client can create a repo,
`git clone`/`push` over smart HTTP (delegated to the real `git http-backend`), file issues that
become typed intents, record Ed25519-signed changes with provenance, open PR-shaped proposals,
attach typed reviews, and land fast-forward merges — with every mutation writing an append-only
`operations` row in the same transaction. A GraphQL read path serves GitHub's real published
schema. Not yet built: GraphQL mutations, validation against the unmodified `gh` binary, gate
runners and evidence bundles, land policy, undo/history query, candidate sets, the MCP native
plane, and the trust plane. See the [status ledger](docs/pragmatic_mvp.md#status-ledger) for the
per-milestone view.

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
| [`docs/adp-prototype-implementation-plan.md`](docs/adp-prototype-implementation-plan.md) | **Historical.** The original 24-week, 6-engineer prototype plan (Rust, jj-derived change engine). Superseded by `pragmatic_mvp.md` on scope, stack, and sequencing; kept because several of its demo scenarios (fleet fan-out, cross-harness resume) remain the north star. |
| [`docs/server-stack-tutorial.md`](docs/server-stack-tutorial.md) | **Onboarding.** The server stack (Node/TypeScript, Fastify, Postgres/Drizzle, Caddy, Docker Compose) explained piece by piece, no prior familiarity assumed. |

New readers: start with the brief for the argument, then `pragmatic_mvp.md` for what is actually
being built, in what order, and why the scope is what it is.

## Where the plan diverges from the brief

`docs/pragmatic_mvp.md` accepts the thesis but changes five things, each argued in its Part 1:

- **Sequence forge → adoption → standard**, not standard-first. A spec with one implementation and
  no users is a document, not a standard.
- **Git *is* the store; ADP is an overlay beside the DAG.** Defers the jj-derived change engine
  entirely and removes the hardest open research question from the critical path.
- **The defensible core of verification is policy, not infrastructure** — the evidence schema and
  statistical land criteria, not a hermetic build graph.
- **Promote the genuinely novel primitive:** N competing candidate solutions to one intent. Merge
  queues are commoditized; this has no GitHub analogue.
- **Serve the read path.** Agents burn most of their tokens reading history, and neither original
  document addresses it.

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
[`server/README.md`](server/README.md).

On a machine that has never seen this project, one command provisions it and one loop runs
everything against a throwaway database that is destroyed afterwards:

```bash
bash scripts/dev/bootstrap.sh          # toolchain, Docker, dependencies
make up && make test-all && make down  # bring up, run, tear down, assert clean
```

`make down` asserts the machine is clean rather than assuming it — no leftover containers,
volumes, server processes or temp directories. See
[`docs/test-environment-automation.md`](docs/test-environment-automation.md).

CI runs typecheck, build, migrations, and the full test suite (unit / integration / end-to-end,
including a real clone→push→propose→review→merge cycle) on every pull request. A separate
clean-room workflow provisions a bare container from scratch and runs the same loop, so the
"brand new machine" path is verified continuously rather than assumed.

## License

Apache-2.0 intended for all code, spec, and conformance suites; CC-BY for prose. The neutrality
claim is the entire thesis, so the licensing boundary is deliberately fixed up front: hosting is a
convenience, never a license lever.
