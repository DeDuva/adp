# ADP Prototype — Implementation Plan

**Companion to: "An Open, Agent-Native Substrate for Version Control and CI/CD"**
*Office of the CTO · July 2026 · Target: Lab Preview in 24 weeks*

---

## 1. Objective and prototype thesis

Build the minimum system that lets a frontier lab run a real agentic workload end-to-end on our substrate and experience the three claims the brief makes: (1) speculative fleet workflows are dramatically better on an agent-native change model than on git; (2) eval-gated merging turns agent throughput into trustworthy, attested software; (3) a neutral protocol (ADP) makes agent work portable across harnesses with one continuous audit trail.

The prototype optimizes for **credibility per engineering week**, not completeness. Every scope decision below follows one rule: *build what proves the differentiated layers (change model, verification, protocol); borrow or stub what the market has already commoditized (storage, git plumbing, sandboxing).*

**Definition of done (Lab Preview):** a design partner can point the prototype at a real repository, fan out 50+ concurrent agent attempts from their own harness, watch an eval-gated merge queue land only attested winners, resume a session in a second harness, and query one signed history answering "which agent changed what, why, and how was it verified" — with git tooling continuing to work against the same repository throughout.

## 2. What we build vs. borrow vs. cut

| Layer | Prototype approach | Rationale |
|---|---|---|
| Change model (L1) | **Build.** Server-side operation log, typed changes, first-class conflicts, CoW workspaces — implemented on `jj-lib` where it fits, reimplemented where server semantics demand | This is the defining IP and the A4 experiment at the same time |
| Verification fabric (L3) | **Build (v0).** Evidence schema, speculative merge queue, pluggable gate runners (pytest, Bazel test, eval adapters) | The uncontested layer; even a v0 is a category demo nobody else has |
| ADP surface (L2) | **Build.** gRPC service + MCP server + thin CLI, spec published from day one | The standard is the product |
| Git interop (L2) | **Borrow.** `gitoxide` for object model and wire protocol; repositories remain valid git repos | Table stakes; zero innovation budget here |
| Storage (L0) | **Borrow.** Git object store for source + Postgres for operation log/metadata/evidence; large-object store (S3-compatible CAS) for artifacts | Defers the Lore-backend decision (A3) without blocking it — backend trait from day one |
| Virtual filesystem | **Cut (stub).** Full or sparse materialization into container workspaces; FUSE/ProjFS deferred | Fleet workflows are demonstrable without lazy hydration at prototype repo sizes |
| GitHub API shim | **Cut (minimal).** Webhook emitter + status/checks endpoints only, enough to keep a partner's existing CI dashboards alive | A2 research will size the real shim; don't guess now |
| Structural/AST merge | **Cut.** Line-based merge + first-class conflicts + LLM resolution agent | A6 argues the eval gate makes this deferrable; the prototype tests that claim |
| Review UI | **Minimal.** Read-only web view: change graph, intent, evidence bundles, provenance queries | Humans review intent and evidence; a table and a diff suffice to demo it |
| Multi-tenant auth/ACLs | **Cut.** Single-tenant per deployment; each partner runs an isolated instance (container image + compose/helm) | Labs will demand isolation anyway; per-path ACLs are post-prototype |

## 3. Architecture (prototype scale)

```
 harnesses (Claude Code, OpenHands, custom) ──┐
        │ ADP (MCP / gRPC)                    │ git CLI / CI
        ▼                                     ▼
 ┌───────────────────────────────────────────────────────┐
 │  adp-server (Rust)                                    │
 │  ├─ ADP service: workspace, change, history, undo     │
 │  ├─ Change engine: op log, typed txns, conflicts      │
 │  ├─ Git gateway (gitoxide): wire protocol, refs       │
 │  ├─ Merge queue: speculative batching + gate runner   │
 │  └─ Provenance: signing, identity, evidence binding   │
 ├───────────────┬──────────────┬────────────────────────┤
 │ git objects   │ Postgres     │ CAS (S3-compat)        │
 │ (source)      │ (ops/meta/   │ (artifacts, traces,    │
 │               │  evidence)   │  eval outputs)         │
 └───────────────┴──────────────┴────────────────────────┘
        │
        ▼
 workspace runners (containers): materialized checkouts,
 gate execution (pytest / bazel test / eval adapters)
```

Key invariants the prototype must honor even at v0, because retrofitting them is impossible: every mutation flows through the operation log (undo is universal or it is nothing); every landed change carries a signed evidence bundle (even if the only gate is "tests passed"); the git view and the ADP view are projections of the same store (no dual-write drift); the storage backend sits behind a trait (A3 stays open).

## 4. Workstreams and milestones

Six engineers plus the CTO on spec/partnerships. Weeks are elapsed, workstreams overlap.

| Phase | Weeks | Deliverable | Exit criterion |
|---|---|---|---|
| **P0 — Skeleton & spec** | 1–4 | ADP v0.1 spec draft (workspace, change, evidence, undo verbs + schemas); walking skeleton: clone a git repo in, fork a workspace over gRPC, commit a typed change, see it via `git log` | External reviewer (design partner architect) can read the spec and file issues; round-trip demo runs in CI |
| **P1 — Change engine** | 3–10 | Server-side operation log; CoW workspace lifecycle + GC; first-class conflict objects; undo/redo of any operation incl. landed changes; provenance signing (per-agent keys, session linkage) | 100 concurrent workspaces on a ~500k-LOC repo; any operation undone in <1s; property-based tests on op-log invariants |
| **P2 — Verification fabric v0** | 7–14 | Evidence schema v0; merge queue with speculative batching; gate-runner interface + three adapters (pytest, `bazel test`, generic eval-command with scored output); risk-tier config (which gates for which paths) | 50-way fan-out lands winners with evidence attached; queue survives injected flaky gates without collapse (basic retry/quarantine policy); p95 land time instrumented |
| **P3 — Harness adapters & interop** | 11–18 | Claude Code adapter (checkpoints, workspace fork, undo → ADP); OpenHands adapter; `adp` CLI for custom harnesses; cross-harness resume demo; minimal review UI; webhook/status shim | Demo D2 (below) passes: session started in harness A resumes in harness B with continuous history |
| **P4 — Lab Preview hardening** | 17–24 | Single-command deployment (container image, compose + helm); seeded demo repos; benchmark harness for the A1 study (git-from-weights vs ADP-from-docs); docs; conformance test suite v0 for the spec | Two design partners running self-hosted instances on a workload of their choosing; benchmark results reproducible by partners |

Design-partner touchpoints are built in, not appended: spec review at week 4, first live demo at week 10, adapter co-development from week 12, self-hosted preview from week 20. The partners shape the spec while it is cheap to change — that is half the point of the prototype.

## 5. Demo scenarios (what a lab actually experiences)

**D1 — Fleet fan-out with attested landing.** From their own orchestrator: fork 50 workspaces against a real OSS repo (candidate: a mid-size Rust or Python project with a good test suite), dispatch the same task with varied prompts/models, watch the merge queue speculatively batch candidates, run gates, land the winner with its evidence bundle, GC the rest. The money shot is the history view: one landed change, intent attached, 49 discarded attempts queryable but not polluting history.

**D2 — Cross-harness portability.** Start a refactoring task in Claude Code; checkpoint via ADP mid-task; resume in OpenHands; land through the queue. One continuous signed history across both harnesses — the LSP-moment demo, and the one no competitor can show.

**D3 — Provenance and undo.** Query: "show every landed change produced by model X under session Y, with evidence." Then undo a landed change — not revert-as-new-commit, but operation-log undo with the full causal record preserved. This is the safety-case demo and lands hardest with lab audiences.

**D4 — The A1 benchmark, live.** Side-by-side token count, command count, error rate, and wall clock for an agent completing identical VCS task suites via (a) git CLI from weights and (b) ADP from docs. Whatever the result, running it transparently is the credibility play — and it gates our own investment per appendix A1.

**D5 — Git keeps working.** Throughout all of the above, a skeptic at the table runs `git clone`, `git log`, `git blame` against the same repository and everything is simply *there*. Compatibility is best demonstrated by refusing to make it a demo.

## 6. Technical decisions locked for the prototype

**Rust throughout the server**, `tonic` for gRPC, official SDK for the MCP server, `gitoxide` for git interop, Postgres for transactional metadata, S3-compatible CAS for blobs/artifacts. **jj-lib as a starting point for change semantics** with an explicit week-8 checkpoint: if server-authoritative multi-writer semantics fight the library (the A4 risk), we keep the data model and reimplement the engine — the spec, not the codebase, is the commitment. **Workspace execution in containers** (runc/gVisor per partner preference); the prototype treats sandboxing as the harness's or platform's concern and provides mount-ready materialized checkouts. **Signing via Sigstore-style keys per agent identity** with the sealed-payload provenance option (A9) stubbed but schema-present, so labs with trace-confidentiality policies can evaluate the shape even before the full implementation exists.

## 7. Risks specific to the prototype

*The merge queue is the long pole.* Speculative batching under flaky gates is genuinely hard (A8); the v0 policy (bounded retries, gate quarantine, risk tiers) must be honest about being v0, and the instrumentation must be good enough that partners' p95 data feeds the real research. *jj-lib divergence* could cost 2–3 weeks at the week-8 checkpoint; the mitigation is the backend/engine trait boundary from day one. *Harness adapter churn* — Claude Code and OpenHands interfaces move fast; adapters are versioned shims and we budget for breakage. *Demo-repo realism* — a toy repo proves nothing to this audience; we invest in seeding a genuinely representative repository with real test/eval suites, and we ask each partner for one internal-scale workload early. *Scope gravity* — every partner conversation will pull toward their stack's missing feature; the cut list in §2 is the contract, and additions trade against the 24-week clock explicitly.

## 8. Success criteria

The prototype has done its job when: **(1)** at least two labs have run a self-selected workload on self-hosted instances; **(2)** at least one harness team (internal or partner) has adopted the ADP checkpoint interface in a branch or fork; **(3)** the D4 benchmark is published with reproducible methodology, whichever way it points; **(4)** the spec repo has substantive issues filed by people we don't employ; and **(5)** the design-partner conversations from the brief's ask have converted into named collaborators on ADP v1. Feature completeness is explicitly not a criterion — the prototype exists to make the standard inevitable, not to be the product.

---

## Appendix: Repository and artifact layout

| Repo | Contents | License |
|---|---|---|
| `adp-spec` | Protocol spec (protobuf + prose), evidence & provenance schemas, conformance test definitions | Apache-2.0 / CC-BY for prose |
| `adp-server` | Reference implementation (Rust): change engine, git gateway, merge queue, ADP service | Apache-2.0 |
| `adp-adapters` | Claude Code, OpenHands adapters; `adp` CLI | Apache-2.0 |
| `adp-bench` | A1/D4 benchmark harness and task suites | Apache-2.0 |
| `adp-deploy` | Container images, compose/helm, seeded demo repos | Apache-2.0 |

Spec and server are public from the first commit. Working in the open from day one is slower and unambiguously worth it: the neutrality claim in the brief is only as credible as the commit history behind it.
