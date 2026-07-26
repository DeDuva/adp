# An Open, Agent-Native Substrate for Version Control and CI/CD

**Technical Brief — Confidential draft for frontier lab leadership**
*Office of the CTO · July 2026 · Apache-2.0, no commercial encumbrance*

---

## The thesis

Software development is shifting from one human on one branch to **fleets of agents running hundreds of concurrent, speculative attempts** against a shared codebase — with a human (or supervising agent) selecting, merging, and attesting the results. Git was designed for none of this: its unit of work is the line-based patch, its conflicts halt automation, and its operations scale with repository size rather than working-set size. The correct architecture separates what agents speak (Git compatibility) from what the system is (a transactional, content-addressed development database).

This is not a speculative claim. Between February and June 2026, five independent, well-resourced efforts — Entire, Cursor Origin, Epic's Lore, Diversion, and Oak — shipped systems built on exactly these premises. The architecture is converging toward consensus. The open question, and the one this brief argues frontier labs must act on, is **who controls the substrate: a vendor's product moat, or a neutral open standard.**

## a) The GitHub interface: the protocol is table stakes; the forge API is the prize

The GitHub interface matters for an epistemic reason, not a technical one: *git* semantics and the GitHub surface are burned into every frontier model's weights from a decade of training data, so breaking them imposes a per-token tax on every agent action. Our position follows the S3/Kubernetes/OCI playbook — support the interface, replace the implementation — sharpened by two observations.

**First: familiarity is a performance tax, not a moat.** A common counterargument (Diversion states it explicitly) holds that agents erode switching costs: an agent can operate an unfamiliar CLI from documentation, adapt scripts, and translate workflows, so "our team already knows Git" no longer blocks migration. This is correct at one depth and incomplete at another. Docs-in-context does let agents drive new tools — but it *is* the per-token tax, and reliability degrades across long agentic trajectories relative to operations performed natively from weights. The synthesis: training-data familiarity no longer prevents alternatives from existing, but it remains a measurable performance tax that makes Git compatibility the right default **until models are post-trained on a new surface.** This one claim explains the whole landscape: it is why five entrants viably ship non-Git internals, and why every one of them nonetheless kept a Git-compatible or Git-mirrored surface.

**Second: the forge API, not the protocol, is the prize.** Every serious entrant (Origin, Entire, Diversion's GitHub Mirroring, Oak's import path, Meta's Sapling before them) independently chose git wire-protocol compatibility: that layer is proven table stakes and non-negotiable. But rather than emulating GitHub's REST/GraphQL surface, each entrant is inventing its own agent-facing forge API — machine-readable review states, programmatic merge queues, MCP-drivable operations. That fragmentation is the opportunity. The GitHub API's long-term importance is lower than commonly assumed; the durable value belongs to whichever **agent-native forge API becomes the neutral standard that models are post-trained against** — an OCI moment. We will ship full git protocol compatibility plus a pragmatic GitHub-API shim for existing CI, but our engineering center of gravity is the open, typed, transactional native surface (MCP and gRPC): `fork-workspace`, `propose-change`, `attach-evidence`, `query-history`, `undo-operation`.

## b) Versioning beyond source: the development database

For agent teams, source is a minority of the state that matters. The unit of versioned truth must expand to the **full development state**: source; build/test graph; context artifacts (specs, agent instructions, design docs); agent memory and session trajectories; prompts and model/tool configurations; and evaluation results. The market confirms provenance and intent are the new payload — Entire versions session transcripts, prompts, and tool calls as Git-native checkpoints (funded by a record seed round), and Diversion ships "Trajectory" to capture the *why* behind AI-generated changes.

Our design differs in two ways that matter to labs. First, **one store and one history for all of it**, so "what changed?" has a single answer whether the change was code, prompt, memory, or tool configuration. Second, every change is a typed transaction: **intent** (the motivating task/spec) → **diff** → **evidence** (tests, evals, benchmark deltas) → **provenance** (which agent, model version, session; which human attested), cryptographically signed. Capturing context — as Entire and Diversion do — is the audit half; **binding context to verification evidence at merge time is the half nobody has built**, and it is the half safety cases and enterprise adoption will require.

Branching becomes cheap speculative forking: copy-on-write workspaces materialized lazily through a virtual filesystem, so an orchestrator fans out 200 attempts and garbage-collects 195. Merging is structural (syntax/AST-aware) and eval-gated, with conflicts as first-class, commit-able objects handed to a resolution agent — Jujutsu's insight — never workflow-halting errors. Agent memory merges with the same machinery and the same audit trail as code.

## c) The landscape: six months from whitespace to contested

Between February and June 2026 the space compressed dramatically: Entire launched its context layer and independent Git network; Epic open-sourced Lore and Cursor announced Origin in the same week; Diversion repositioned its cloud VCS for agentic workloads; Oak reached public beta. Read with the ecosystem signals (Jujutsu's change model; GitButler's benchmark showing agent-oriented CLIs completing VCS tasks ~60% faster with ~80% fewer commands; Freestyle's API-first hosted Git for agent sandboxes), the convergence is unmistakable — and so is the gap.

| Player | What they shipped | What it validates | Gap for frontier labs |
|---|---|---|---|
| **Entire** (Dohmke, ex-GitHub CEO) | "Checkpoints": Git primitive versioning agent sessions, prompts, tool calls, reasoning traces alongside commits; independent Git network mirroring GitHub repos; record seed round in dev tools | Context/intent/provenance as first-class versioned data — our thesis (b), nearly verbatim | Venture platform; business model gestures at monetizing agent "data exhaust"; no verification layer; labs would rent their provenance |
| **Cursor Origin** (Anysphere) | Git-compatible forge for parallel agents: stacked PRs (Graphite acquisition), merge queues, machine-readable review states, MCP-drivable; demoed 100k+ clones/hr on one repo | Forge layer is the bottleneck; concurrency and machine-readable review as the design center — our thesis (a) | Proprietary, product-captive, SpaceX-adjacent post-acquisition; labs would build on a competitor's closed stack |
| **Epic Lore** | Open-source (MIT, open spec) centralized content-addressed VCS: Merkle-tree revisions, fragment-level dedup, lazy sparse working copies; pairs with Horde CI/CD | Our Layer 0 storage architecture, independently derived; binary-scale payloads (weights, datasets) as first-class | Game-industry design center; not agent-native — no intent, provenance, or agent-facing change model |
| **Diversion** | Full-stack cloud-native VCS (not a Git layer): central repository with unlimited ephemeral working copies, no local clones; binary/monorepo-native; bi-directional GitHub mirroring; "Trajectory" provenance product | Centralized store + cheap workspace forking + provenance capture; and the switching-cost-erosion argument (agents lower the cost of leaving Git) | Closed-source commercial SaaS; no verification layer; provenance capture without merge-time evidence binding |
| **Oak** | Purpose-built Rust VCS: ~1s virtual mounts, no full clone, per-task branch isolation for parallel agents; claims ~50% fewer VCS tokens, ~90% faster ops | Token cost and mount latency as first-order VCS metrics; per-task workspace isolation | Early and thin (small team); no server-side collaboration or verification story |
| **Ecosystem** (jj, GitButler, Freestyle, Sapling) | jj: operation log, first-class conflicts. GitButler: agent hooks + 300-run VCS agent benchmark. Freestyle: API-first hosted Git for agent sandboxes. Sapling: Git facade over different internals at Meta scale | The change-model, benchmarking, and facade patterns we adopt | Fragments, not a substrate: none combines change model + storage + verification + neutrality |

Three structural observations:

1. **Convergent architecture.** All five entrants converged on centralized-ish, content-addressed storage with lazy virtualization behind a git-compatible or git-mirrored surface, and some notion of provenance. Independent convergence by teams with very different incentives — an ex-GitHub CEO, an IDE company, a game engine, a Perforce challenger, an indie — is the strongest available evidence the architecture is right.
2. **Nobody owns verification.** Every entrant stops at capture and hosting. None leads with the hermetic incremental build/test graph and eval-gated merge queue — the layer that determines whether agent-scale throughput actually lands as trustworthy software.
3. **Neutrality is collapsing.** GitHub is Microsoft's; Origin is Cursor's and, post-acquisition, SpaceX-adjacent; Entire is a venture platform whose stated model points toward monetizing agent data exhaust; Diversion and Oak are closed or thin. Every frontier lab competes with at least one of these owners. The window for a neutral substrate is open now and will not stay open.

## d) Architectural tradeoffs, and why Google still runs Piper

Google is not on Piper out of inertia. A distributed VCS forces every client to reason about a replica of history; at billions of lines that is physically untenable, and it forecloses what Google actually monetizes internally: a single linear source of truth enabling atomic cross-cutting changes (Rosie), fine-grained per-path ACLs, and — decisively — tight coupling to an incremental, content-addressed build/test graph (Blaze/TAP) so any change's blast radius is computable and only affected targets rebuild. The VCS is one organ of a vertically integrated organism; git cannot replace it because git only replaces the organ. Epic demonstrated the same conclusion from another industry: Lore ships alongside Horde (CI/CD and artifact distribution), not instead of it.

The lesson for agentic development: **agent fleets have Google-scale coordination problems even in mid-size repos** — thousands of concurrent writers, constant speculative execution, a verification bottleneck — so the winning design borrows the monorepo stack's centralized, virtualized, build-graph-integrated core while keeping Git's open interface and offline-tolerant edges.

| System | Core model | Strengths | Costs / limits for agentic dev |
|---|---|---|---|
| **Git / GitHub** | Distributed; full replica; snapshot DAG; line-based 3-way merge | Universal; in every model's training data; enormous tool ecosystem | O(repo) operations; index/staging confuses agents; conflicts are workflow-blocking errors; no operation log; no native provenance |
| **Piper** (Google) | Centralized DB-backed store; CitC virtual FS; trunk-based | Billions of LOC; atomic cross-repo changes; fine-grained ACLs; one source of truth feeding Blaze/TAP/Critique | Requires connectivity + massive bespoke infra; closed; value comes from vertical integration, not the VCS alone |
| **Sapling / Mononoke / EdenFS** (Meta) | Centralized server, lazy virtual checkout; UX decoupled from storage format | Ops scale with working set, not repo size; proved Git can be a facade over different internals | Server + VFS never fully productionized externally; ecosystem still keys off GitHub |
| **Jujutsu** (jj) | Git-compatible backend; working copy is a commit; operation log; first-class conflicts | Universal undo; conflicts commit-able and resolvable later; pluggable storage — ideal change model for agents | Client-side only today; no server/collaboration layer; young ecosystem |
| **Lore** (Epic) | Centralized server-of-record; content-addressed Merkle-tree revisions; chunk-level dedup; lazy materialization; open spec | Binary-scale payloads native (no LFS bolt-on); open spec invites third-party implementations | No agent-native change model; no intent/evidence/provenance semantics; young outside Epic's workloads |
| **Diversion** | Full-stack cloud VCS; central repo, ephemeral working copies, no local replica | Simplest mental model for humans and agents; binary/monorepo native; GitHub mirroring proven in production | Closed SaaS; no open spec; no operation-log/undo semantics or evidence model exposed |

## e) The agent harness boundary: the most contested interface in the stack

Any credible position on agent-era version control must answer a question the industry has barely articulated: **where does the agent harness end and the development substrate begin?** By "harness" we mean the runtime around the model — Claude Code, Codex CLI, Gemini CLI, OpenHands, Devin, Cursor's agents, and their successors: the layer that assembles context, plans, invokes tools, sandboxes execution, and orchestrates subagents.

**The interface is neither clear nor static — it is actively drifting, and drifting in one direction.** For thirty years the editor/VCS/CI boundary was stable because a human was the integrator between the layers. Agents dissolve that boundary because the harness is now the integrator, and every harness is discovering that the substrate beneath it lacks the primitives agentic work requires. So each builds them privately. Harnesses today implement their own checkpoint-and-rewind mechanisms (often shadow repositories or file snapshots maintained outside version control), their own session persistence and resumption, their own memory files and context-loading conventions, their own multi-workspace orchestration atop git worktrees, and their own ad-hoc conflict handling (typically retry-and-rebase loops). Each of these is a version-control primitive, reinvented per-harness, invisible to the repository's history, and incompatible with every other harness.

**Left alone, this drift is the default future, and it is a bad one.** Features migrate to whoever ships them first. If the substrate does not provide operation logs, workspace lifecycle, memory versioning, conflict representation, and evidence binding, every harness vendor will keep building proprietary shadow versions — and three consequences follow. Provenance fragments: an enterprise running three harnesses gets three incompatible audit trails, none complete. Work becomes non-portable: a task started in one harness cannot be resumed, reviewed, or verified in another. And the harness becomes the lock-in point: whoever owns the harness owns the development state, which is precisely the vertical-integration play Cursor is making by pairing its harness with its own forge. The pre-LSP editor world is the exact precedent — every editor reimplementing per-language intelligence, badly, until a neutral protocol moved the capability behind a standard interface and let editors compete on experience instead.

**Harnesses both threaten and need this thesis.** They threaten it where a vendor has moat incentives to fuse harness and substrate (Cursor/Origin is the live example; GitHub could follow). They support it everywhere else: most harness builders do not want to maintain VCS infrastructure — shadow-git checkpointing is a liability they would gladly delete — and the frontier labs, who build the most-used harnesses, have the *opposite* of a lock-in incentive: their harnesses win on model quality, and they benefit when enterprises can adopt them without forfeiting cross-harness auditability. The correct division of labor follows from the physics of the layers:

| Concern | Harness (policy) | Substrate (state & truth) |
|---|---|---|
| Context | Decides what to load, when, for which task | Versions the artifacts; serves them; records what was loaded (provenance) |
| Memory | Decides what to remember and when to recall | Stores, versions, merges, and audits it |
| Workspaces | Requests forks; schedules attempts | Owns lifecycle: copy-on-write forking, isolation, GC |
| Checkpoints / undo | Decides when to checkpoint and when to rewind | Owns the operation log; makes undo universal and durable |
| Conflicts | May supply the resolution agent | Represents conflicts first-class; records resolution + evidence |
| Verification | Decides which evals matter for the task | Runs the hermetic build/test/eval graph; binds evidence at merge |
| Identity | Presents agent credentials | Verifies, signs, and anchors provenance |

In short: **the harness is the brain and hands; the substrate is the world and the ledger.** Harnesses should compete furiously on planning, context engineering, and model quality — and should not be able to compete on owning your history.

**The success scenario, concretely:** we will have turned the *agent workspace, change, and evidence protocol* into this decade's LSP — an open standard (working name: **ADP, the Agent Development-state Protocol**) that every harness speaks and any conforming server implements. A task begun in Claude Code is checkpointed through ADP, resumed in OpenHands, reviewed in a third-party UI, and landed through an eval-gated merge queue — with one continuous, signed history of intent, changes, and evidence across all of them. Harness vendors delete their shadow-VCS code the way editors deleted their per-language parsers. CI and safety tooling consume one evidence format regardless of which agent did the work. That — not a forge, not a hosting business — is the standard worth building, and it is only credible if it is neutral, open, and co-designed with the labs whose harnesses must adopt it.

## What we will build

Our center of gravity sits deliberately up the stack: **commoditize what the market is converging on; own what is uncontested.**

**Layer 3 — Verification fabric (the lead).** A hermetic, incremental, remote-cached build/test graph (Bazel-compatible) plus an **eval-gated speculative merge queue**: candidate merges batched speculatively, incremental tests and behavioral evals executed against the merged state, and only attested winners landed — each carrying its evidence bundle. When agents write most of the code, verification — not authoring — is the throughput constraint; this is the hardest layer, the least contested, and the one labs bottleneck on today.

**Layer 1 — Change model.** Jujutsu-derived semantics: operation log, universal undo, first-class conflicts, copy-on-write workspace forking, typed changes carrying intent, evidence, and signed agent/human provenance. This schema — not storage — is where our defining IP lives, published as the ADP open specification designed for multi-vendor implementation.

**Layer 0 — Store: interoperate, don't reinvent.** Pluggable content-addressed backends rather than a bespoke store: git object stores for compatibility, and Lore's open, MIT-licensed specification as a first-class backend for binary-scale payloads (model weights, datasets, eval artifacts). Embracing a converging open spec is both faster and a credible open-ecosystem signal. A virtual filesystem (FUSE/ProjFS) provides lazy, working-set-scaled materialization across backends.

**Layer 2 — Interfaces.** Full git wire-protocol support and a pragmatic GitHub-API shim for existing CI; the native ADP surface (MCP and gRPC) as the preferred agent interface and proposed standard; reference harness adapters for the major agent CLIs so adoption requires configuration, not integration work; a stacked-diff-native review UI where humans review intent and evidence, not just hunks.

## Why frontier labs specifically — and the ask

Each lab is independently rebuilding fragments of this stack: sandboxed repo services, merge heuristics, eval gates, trajectory logging, harness-private checkpointing. Meanwhile the emerging alternatives are owned by parties every lab competes with, and at least one intends to monetize the behavioral data your agents generate. Frontier labs are the only actors with both the incentive and the leverage to force a neutral standard: you build the dominant harnesses, and you control what models are post-trained on — the two facts that jointly decide which protocol wins in an agent-first world. An open substrate turns duplicated internal cost into a common target, and produces the provenance-plus-evidence layer (who, what, why, and *how verified*, for every change) that safety cases, regulators, and enterprise buyers will demand.

**The ask:** two to three design partners in Q3 on (1) the ADP specification — the native agent API and change schema, co-designed against your harnesses; (2) the merge-queue evidence format; and (3) a joint post-training corpus for the native surface. We contribute the reference implementation under Apache-2.0; governance moves to a neutral foundation once two independent implementations exist.

---

# Appendix: Open decisions, tradeoffs, and research agenda

The brief above states our positions with conviction; this appendix states them with honesty. Each item is a decision where credible evidence could change our approach, ordered roughly by how much of the architecture it would move.

## A1. Will labs actually post-train on a native surface?

**Current bet:** Yes — labs will post-train models against the ADP surface, making the Git facade an off-ramp rather than the main road.
**What would change it:** If in-context tool descriptions (MCP) plus improving long-horizon tool use close most of the reliability gap, post-training on a bespoke surface may never be worth a lab's training budget. In that world, the Git facade is permanent, the native API is a niche, and our differentiation collapses back to the verification layer alone.
**Research:** Extend the GitButler/Oak methodology into a rigorous benchmark: token cost, command count, error rate, and *task-completion reliability over long trajectories* for (a) git-from-weights, (b) novel-CLI-from-docs, (c) native-API-from-docs, across model generations. This single study also settles the switching-cost debate quantitatively, and its result should gate how much we invest in the native surface versus the shim.

## A2. Depth of GitHub compatibility

**Current bet:** Full git wire protocol; pragmatic (partial) GitHub REST/GraphQL shim.
**What would change it:** If lab and enterprise CI estates prove too entangled with GitHub Actions, checks, and webhooks, a partial shim becomes an adoption cliff and we'd need near-complete API emulation — a large, thankless, perpetually-chasing-upstream surface. Conversely, if A1 resolves strongly toward native surfaces, even the shim may be wasted effort.
**Research:** Audit the actual GitHub API call distribution of representative agent frameworks (Claude Code, Codex CLI, OpenHands, SWE-agent) and of lab-internal CI. Hypothesis: a small fraction of endpoints covers the large majority of traffic; measure the tail.

## A3. Bespoke store vs. Lore backend vs. git objects

**Current bet:** Pluggable backends; adopt Lore's open spec for binary-scale payloads rather than building Layer 0 from scratch.
**What would change it:** Three risks. Lore's spec may encode game-industry assumptions (revision semantics, locking, ACL model) that fight our transaction model; Epic controls spec evolution and its governance interest is game development, not agents; and write-path performance under thousands of concurrent small transactions is unproven — Lore is optimized for large-binary read/dedup patterns, while agent fleets generate Piper-like high-frequency small-write workloads (which is why Piper is DB-backed).
**Research:** Gap analysis of the Lore spec against our typed-transaction requirements; write-throughput benchmark at agent-fleet concurrency (target: thousands of concurrent workspace commits/sec); a conversation with Epic about spec governance. Fallback positions, in order: contribute agent extensions upstream; fork the spec; DB-backed bespoke store for the change log with Lore for blob storage only (a Piper-like split).

## A4. Jujutsu: adopt, fork, or reimplement server-side

**Current bet:** Jujutsu-derived change semantics (operation log, first-class conflicts, working-copy-as-commit).
**What would change it:** jj is a client-side system; nobody has proven its model as a *server-authoritative, multi-tenant, thousands-of-concurrent-writers* substrate. If the operation-log model doesn't extend cleanly to a shared server (log compaction, cross-workspace causality, ACL-aware history), we'd reimplement the semantics on a purpose-built transactional core rather than build on jj's codebase. Google's own internal direction (jj as the client for Piper-backed repos) is the strongest external signal to track — it would validate exactly the client-model/server-store split we propose.
**Research:** Prototype a server-side operation log with the jj data model at target concurrency; engage jj maintainers on backend-trait stability; monitor Google's jj integration milestones.

## A5. Centralized-first vs. local-first

**Current bet:** Centralized source of truth with offline-tolerant edges (local operation log buffering, reconciliation on reconnect).
**What would change it:** Air-gapped lab environments, sovereign/on-prem deployment requirements, or agent execution at the edge could make "always connected" the wrong default for exactly our target customers. The intellectually serious alternative is a local-first CRDT-based sync model — but CRDTs guarantee convergence, not *correctness*, and code demands correctness; that is why we reject them for source (while remaining open to them for memory/context, see A7).
**Research:** Requirements interviews with lab infra teams on air-gap and data-residency constraints; evaluate a hybrid where each site runs a full replica server (Mononoke-style multi-region) rather than pushing distribution to clients.

## A6. Structural (AST-aware) merge vs. agent-mediated merge

**Current bet:** Both — syntax-aware structural merge where language support exists, with first-class conflicts handed to resolution agents elsewhere.
**What would change it:** Structural merge is a per-language maintenance treadmill (grammar coverage, semantic edge cases) with a long history of promising research and limited production adoption. If LLM-as-merge-driver proves reliable enough, the treadmill isn't worth running — line-based merge + first-class conflicts + a strong resolution agent + eval gates may dominate on cost and correctness. The eval-gated queue changes this calculus fundamentally: merge mistakes no longer need to be prevented, only *caught*.
**Research:** Corpus study of real agent-fleet conflict rates and types; head-to-head correctness evals of structural merge vs. LLM merge drivers vs. hybrid, scored by downstream test/eval outcomes rather than textual fidelity.

## A7. Is agent memory really a merge problem?

**Current bet:** Memory and context version through the same store and history as code.
**What would change it:** Memory may be better modeled as a database with its own consistency semantics (append-mostly logs, vector indices, TTL/decay) than as merge-able files; forcing it through code-merge machinery could be a category error. The defensible core of our position is narrower: memory changes need the *same audit trail and provenance*, even if their write path differs.
**Research:** Characterize memory access patterns across production agent frameworks (write frequency, conflict frequency, read patterns); determine whether snapshot-versioning with provenance (cheap) captures most of the value of full merge semantics (expensive).

## A8. Eval-gated merging under nondeterminism

**Current bet:** The merge queue lands only changes with attached passing evidence, including behavioral evals.
**What would change it:** Evals are stochastic, expensive, and slow. A naïve gate turns flakiness into queue collapse — speculative batching amplifies retry storms (a failure mode the merge-queue literature documents for *deterministic* tests; nondeterminism is worse). If eval gating can't hit acceptable p95 land-times, it degrades to advisory-only, weakening our central differentiator.
**Research:** This is our deepest open technical problem and likely our most defensible contribution: statistical land criteria (sequential testing, confidence-interval gates) instead of binary pass/fail; risk-tiered gating by blast radius computed from the build graph; cost models for speculative batch sizing under stochastic verdicts. Publish this as research — it recruits both engineers and lab credibility.

## A9. Provenance vs. confidentiality

**Current bet:** Every change carries signed provenance: agent identity, model version, session linkage, evidence.
**What would change it:** Labs may be unwilling to persist reasoning traces and prompts — for IP reasons, for safety reasons (trace confidentiality policies), or for legal discoverability reasons. If the richest provenance is unstorable, the schema must support graduated disclosure: hashes and attestations in the shared history, encrypted or lab-retained payloads, redaction that preserves verifiability. There is also an unsolved identity primitive: what, cryptographically, *is* an agent identity across ephemeral sandboxes, and who holds its keys?
**Research:** Design-partner interviews on trace retention policy; adapt SLSA/in-toto attestation patterns to agent provenance; prototype hash-with-sealed-payload evidence records.

## A10. Standardization strategy and the incumbent response

**Current bet:** Implementation-first, spec published early, neutral foundation after two independent implementations.
**What would change it:** The gravest strategic risk in this brief: GitHub ships credible agent-native primitives (machine-readable reviews, hosted merge queues, trajectory storage) and moots the neutral standard by default — distribution beats architecture on most timelines. Secondary risk: premature foundation governance produces design-by-committee before the reference implementation earns authority (the OCI lesson cuts both ways). If GitHub moves first, our fallback is to become the open *conformance layer* — the spec and test suite that GitHub's own agent API gets pressured to comply with — rather than a competing forge.
**Research:** Track GitHub/Microsoft agent-platform announcements as a standing intelligence function; case studies on OCI, CNCF, and LSP timing (LSP is the optimistic precedent: a vendor-published spec that became neutral infrastructure); define the minimum spec surface that creates multi-vendor pressure.

## A11. The monorepo assumption

**Current bet:** Monorepo-biased design (single history, atomic cross-cutting changes, build-graph blast radius).
**What would change it:** Most prospective adopters live in polyrepo estates with dependency graphs, and Conway's-law realities (team autonomy, vendored open source, acquisition sprawl) won't vanish because agents arrived. If federation across repos proves essential, "atomic change" must generalize to a two-phase commit across repositories — substantial added complexity that Piper never had to solve.
**Research:** Survey design partners' repo topologies; determine whether GitHub-mirrored polyrepos can be presented as *virtual monorepos* (one logical history, many physical remotes) without full distributed-transaction machinery.

## A12. Will harness vendors adopt a neutral substrate?

**Current bet:** Yes — labs' harnesses win on model quality, not state lock-in, so they adopt ADP; the drift of VCS primitives into harnesses (§e) reverses once a standard exists, as it did with LSP.
**What would change it:** The counter-scenario is vertical integration winning: harness vendors with forge ambitions (Cursor today; potentially GitHub/Copilot) treat proprietary state as the moat, ship it bundled, and enterprises accept fragmentation because each bundle is individually convenient. A second failure mode is a *partial* standard: harnesses adopt ADP for checkpoints (cheap to adopt) but keep memory and orchestration state proprietary (where differentiation lives), leaving the audit trail incomplete — arguably worse than no standard, because it looks complete.
**What would confirm it:** Any lab harness shipping a public checkpoint/state interface, or enterprises putting cross-harness auditability into procurement requirements.
**Research:** Map the actual state surfaces of the major harnesses (what they persist, where, in what format) as the empirical basis for the ADP scope; identify the minimum protocol slice that makes portability real rather than cosmetic; test appetite with harness teams at two labs — this doubles as the design-partner conversation in the ask.

---

*Prepared for discussion with frontier-lab technical leadership. Positions in the main brief are current convictions; every item in the appendix names the evidence that would change them.*
