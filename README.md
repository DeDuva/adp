# ADP — Agent Development-state Protocol

**Status: design phase. No code yet — this repository currently holds three documents.**

## What this is

Software development is shifting from one human on one branch to fleets of agents running many
concurrent, speculative attempts against a shared codebase. Git was designed for none of that: its
unit of work is the line-based patch, its conflicts halt automation, and its operations scale with
repository size rather than working-set size. Meanwhile every agent harness — Claude Code, Codex,
OpenHands, Cursor's agents — is privately reinventing the same version-control primitives
(checkpoint/rewind, session persistence, memory files, multi-workspace orchestration), each one
invisible to the repository's history and incompatible with every other harness.

ADP is a proposed open, neutral substrate for that world: an agent-native version control and
verification layer where every change is a typed transaction carrying **intent → diff → evidence →
provenance**, cryptographically signed, with a server-side operation log and universal undo.
Git compatibility is preserved throughout — `git clone` keeps working.

The differentiating bet is not storage or the change model, both of which the market is rapidly
converging on. It is **binding context to verification evidence at merge time** — capturing *why* a
change was made and *how it was verified* in one signed record. Several well-funded efforts capture
provenance; none gate on it.

## The documents

| Document | What it is |
|---|---|
| [`docs/agent-native-vcs-brief-v4.md`](docs/agent-native-vcs-brief-v4.md) | **The thesis.** Technical brief arguing the case for a neutral agent-native substrate: the GitHub interface question, versioning beyond source, the competitive landscape, architectural tradeoffs, and the agent-harness boundary. Its appendix (A1–A12) states the open decisions honestly — each names the evidence that would change the position. |
| [`docs/adp-prototype-implementation-plan.md`](docs/adp-prototype-implementation-plan.md) | **The original prototype plan.** A 24-week, 6-engineer build targeting a lab preview: Rust server, jj-derived change engine, verification fabric, harness adapters. Optimizes for proving the brief's theses to a frontier lab. |
| [`docs/pragmatic_mvp.md`](docs/pragmatic_mvp.md) | **The current plan of record.** A critique of the concept plus a much narrower MVP: the smallest system an off-the-shelf agent can use *instead of* GitHub, with everything complex deferred and defended. Supersedes the prototype plan on scope, stack, and sequencing. |

New readers: start with the brief for the argument, then read `pragmatic_mvp.md` for what is
actually being built and why the scope is what it is.

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

## License

Apache-2.0 intended for all code, spec, and conformance suites; CC-BY for prose. The neutrality
claim is the entire thesis, so the licensing boundary is deliberately fixed up front: hosting is a
convenience, never a license lever.
