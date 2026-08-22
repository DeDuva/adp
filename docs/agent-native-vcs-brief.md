# An Open, Agent-Native Substrate for Version Control and CI/CD

**Technical Brief — version 6 · public draft**
*ADP project · August 2026 · Apache-2.0, no commercial encumbrance*

*Audience note: this brief is written for technical leadership at frontier labs and
agent-infrastructure teams, and is published openly — neutrality is the thesis, and a neutral
substrate should not have a private pitch. The filename no longer carries a version number; the
version is stated above and every prior revision is in git history.*

*What v6 changes. The workload thesis moves from wide speculative fan-out to **small-N concurrent
agents with one integrator and conventional CI** — a reweighting v5 made in its appendix and never
carried into its body, now supported by our own pre-registered measurement as well as the market's.
§g is new: what it costs to store intent, trajectories and evidence, from measured numbers rather
than assertion. §e changes its precedent from LSP to OpenTelemetry and names a concrete adoption
path that did not exist in July. §c is refreshed through 21 August 2026, and the claim that nobody
owns verification is narrowed to the one that survives contact with what shipped since. And the
appendix drops from eighteen open questions to **three open decisions and six positions with
tripwires** — because nine of the eighteen were settled by our own code or our own measurements,
and a brief that argues its positions is stronger than one that lists them as doubts.*

---

## The thesis

Software development is shifting from one human on one branch to **fleets of agents proposing
changes faster than any human integrator can review them**. That shift is real; the shape it takes
is not the one this brief originally assumed. The characteristic unit is not a swarm of hundreds of
speculative attempts. It is a handful of concurrent agents, each iterating against conventional CI
until it believes its work is done, landing through one integration point — with wide fan-out
reserved for hard problems and mass remediation. Git was designed for neither: its conflicts halt
automation, its operations scale with repository size rather than working-set size, and it has no
representation at all for *why* a change was made or *how* it was verified. The correct
architecture separates what agents speak (Git compatibility) from what the system is (a
transactional, content-addressed development database).

This is not a speculative claim. Between February and August 2026, six independent, well-resourced
efforts — Entire, Cursor (Origin and Continuity), Epic's Lore, Diversion, and Oak — shipped systems
built on these premises. The architecture is converging toward consensus. The open question, and
the one this brief argues frontier labs must act on, is **who controls the substrate: a vendor's
product moat, or a neutral open standard.**

Two corollaries follow, and they are what v6 is for. The enterprises these agents work inside have
made supply-chain security controls a precondition of purchase, and the same admission-time
architecture that makes landing trustworthy is the only credible way to deliver those controls at
agent scale (§f). And a substrate that versions intent, trajectories and evidence alongside code
takes on a storage bill that nobody in this space has costed in public, including us until now
(§g).

## a) The GitHub interface: the protocol is table stakes; the forge API is the prize

The GitHub interface matters for an epistemic reason, not a technical one: *git* semantics and the
GitHub surface are burned into every frontier model's weights from a decade of training data, so
breaking them imposes a per-token tax on every agent action. Our position follows the
S3/Kubernetes/OCI playbook — support the interface, replace the implementation — sharpened by two
observations.

**First: familiarity is a performance tax, not a moat.** A common counterargument (Diversion states
it explicitly) holds that agents erode switching costs: an agent can operate an unfamiliar CLI from
documentation, adapt scripts, and translate workflows, so "our team already knows Git" no longer
blocks migration. This is correct at one depth and incomplete at another. Docs-in-context does let
agents drive new tools — but it *is* the per-token tax, and reliability degrades across long
agentic trajectories relative to operations performed natively from weights. The synthesis:
training-data familiarity no longer prevents alternatives from existing, but it remains a
measurable performance tax that makes Git compatibility the right default **until models are
post-trained on a new surface.** This one claim explains the whole landscape: it is why six
entrants viably ship non-Git internals, and why every one of them nonetheless kept a
Git-compatible or Git-mirrored surface.

**We have since measured the tax on ourselves, and it pointed the wrong way.** In our three-way
cost benchmark, driving ADP through its *native* MCP plane cost **$0.1435 per trial** against
**$0.0848** through `gh` against the same server and **$0.0850** against real GitHub — the native
surface was 1.7× the cost of the compatibility surface. The cause is legible and fixable (there is
no proposal-open MCP tool, so the agent pays a `curl` round-trip that `gh` bundles into one
command), but the number is real and it is ours. It is the reason the native plane's purpose is one
of the three open decisions this brief still carries, rather than an assertion in its body.

**Second: the forge API, not the protocol, is the prize.** Every serious entrant independently
chose git wire-protocol compatibility: that layer is proven table stakes and non-negotiable. But
rather than emulating GitHub's REST/GraphQL surface, each entrant is inventing its own agent-facing
forge API. That fragmentation is the opportunity. The durable value belongs to whichever
**agent-native forge API becomes the neutral standard that models are post-trained against** — an
OCI moment. We ship full git protocol compatibility plus a pragmatic GitHub-API shim, and the open,
typed, transactional native surface (REST and MCP) beside it.

## b) Versioning beyond source: the development database

For agent teams, source is a minority of the state that matters. The unit of versioned truth must
expand to the **full development state**: source; context artifacts (specs, agent instructions,
design docs); agent memory and session trajectories; prompts and model/tool configurations; and
evaluation results. The market confirms provenance and intent are the new payload — Entire versions
session transcripts, prompts, and tool calls as Git-native checkpoints, and Diversion ships
"Trajectory" to capture the *why* behind AI-generated changes.

Our design differs in two ways that matter to labs. First, **one namespace and one history for all
of it**, so "what changed?" has a single answer whether the change was code, prompt, memory, or
tool configuration. (One *namespace*, deliberately, not one engine — §g is about why that
distinction is load-bearing rather than pedantic.) Second, every change is a typed transaction:
**intent** (the motivating task/spec) → **diff** → **evidence** (tests, evals, benchmark deltas) →
**provenance** (which agent, model version, session; which human attested), cryptographically
signed. Capturing context — as Entire and Diversion do — is the audit half; **binding context to
verification evidence at the moment of landing is the half nobody has built**, and it is the half
safety cases and enterprise adoption will require.

Two primitives follow that GitHub cannot express, both built and CI-tested here, and both
under-argued in previous versions of this brief. **Candidate sets** — N competing proposals against
one intent, with a selection recorded as an operation — are the fan-out mode's primitive: N
remediation attempts against one vulnerability intent, or a model ensemble on a hard problem. And
the **semantic history query** — ask the log by actor, verb, date and path rather than by
reconstructing a diff — is where the token savings actually are, because it replaces the
read-everything-and-infer loop that dominates an agent's context budget.

Workspaces are cheap forks projected as branches, so an orchestrator can run a handful of parallel
attempts and discard the losers. Conflicts are failed merges handed back to the agent, exactly as
on GitHub today — first-class conflict objects are a thing we deliberately did not build, and §2.5
of the plan of record explains why the eval gate makes catching merge mistakes worth more than
preventing them.

## c) The landscape: from whitespace to contested in six months

Between February and August 2026 the space compressed dramatically, and the two months since v5
were the most eventful yet. Cursor shipped **Origin** into open beta and published **Continuity**,
the most detailed git-storage engineering artifact of the year, while its parent Anysphere was
acquired by SpaceX for $60B all-stock (closed 14 August). Oak grew a server, native CI and a merge
gate. GitHub standardised the agent *input* surface with Agent Plugins. Read together, the
convergence is unmistakable — and so, still, is the gap.

| Player | What they shipped | What it validates | Gap for frontier labs |
|---|---|---|---|
| **Cursor — Continuity** | Git storage at scale: a write-ahead log in S3 as source of truth, a normal git repo on NVMe as warm cache, atomic CAS on S3 instead of consensus, rendezvous hashing instead of routing tables, UDP gossip replication. Claims 120 pushes/s on S3 Standard, 300+/s on S3 Express, linear read scaling to 100 replicas | Our Layer 0 position, independently derived and pushed much harder: *keep real git, don't distribute the objects*. The most sophisticated statement of that argument anyone has published | A storage layer and nothing else — no intent, no evidence, no verification, no agent change model. Measured on Cursor's own monorepo, unreproduced |
| **Cursor — Origin** | Agent-oriented code hosting: repos, PRs, browsing, GitHub sync. **Open beta 17 Aug** to paid plans | The forge layer is contested ground | Thinner than the June framing promised: no merge queue, no stacked PRs, no machine-readable review. Cursor's own changelog keeps **GitHub as the source of truth** for synced repos. Now owned by SpaceX — every lab's neutrality calculus changed on 14 August |
| **Entire** (Dohmke, ex-GitHub CEO) | "Checkpoints": Git-primitive versioning of agent sessions, prompts, tool calls and reasoning traces alongside commits; distributed Git network in public preview since 8 July; ForgeMark, an open push-throughput benchmark; record $60M seed | Context/intent/provenance as first-class versioned data — thesis (b), nearly verbatim | Venture platform whose business model centers on hosting the agent-session data layer; no verification layer; labs would rent their provenance |
| **Oak** | **Grew past its v5 description.** Now a server, not just a client: native CI in `.oak/workflows`, a **merge gate that refuses a squash while CI is red**, verified content-addressed commits, policy as a repo file, a checkout-free branch-review API returning a merge-safety verdict | Gates at the landing point are now table stakes, not differentiation. Independent convergence on policy-as-versioned-file | The gate takes `--force`. A bypassable gate is a linter with good manners; the enterprise question is what an admin can make *non*-bypassable |
| **Epic Lore** | Open-source (MIT, open spec) centralized content-addressed VCS: Merkle-tree revisions, fragment-level dedup, lazy sparse working copies; pairs with Horde CI/CD | Content-addressed storage with chunk dedup as the right shape for large payloads | Game-industry design center; not agent-native — no intent, provenance, or agent-facing change model |
| **Diversion** | Full-stack cloud-native VCS: central repository, unlimited ephemeral working copies, no local clones; bi-directional GitHub mirroring; "Trajectory" provenance product | Centralized store + cheap workspace forking + provenance capture; and the switching-cost-erosion argument | Closed-source commercial SaaS; provenance capture without merge-time evidence binding |
| **Ecosystem** (jj, GitButler, Freestyle, Sapling, Critique) | jj: operation log, first-class conflicts. GitButler: agent hooks + a 300-run VCS benchmark. Freestyle: API-first hosted git for agent sandboxes. Sapling: git facade over different internals at Meta scale. Critique: a **Merge Gate API** with a merge-policy compiler | The change-model, benchmarking and facade patterns we adopt — and, in Critique, the first serious statement that merge policy wants a compiler | Fragments, not a substrate: none combines change model + storage + verification + neutrality |

Three structural observations, one of them narrowed since v5:

1. **Convergent architecture.** Every entrant converged on centralized-ish, content-addressed
   storage with lazy virtualization behind a git-compatible or git-mirrored surface, plus some
   notion of provenance. Independent convergence by teams with very different incentives — an
   ex-GitHub CEO, an IDE company now owned by a launch provider, a game engine, a Perforce
   challenger, an indie — is the strongest available evidence the architecture is right.

2. **Gates are normalised; *non-bypassable attested evidence* is not.** v5 claimed nobody owns
   verification. That claim no longer survives: Oak ships a merge gate, Critique ships a Merge Gate
   API, and AI code review (CodeRabbit, Greptile, Bugbot, Copilot) has made merge-blocking gates
   ordinary. The claim that *does* survive is narrower and better: **nobody binds attested,
   policy-bound evidence to the landing decision in a way an administrator can make
   non-bypassable.** Oak's gate takes `--force`. GitHub's branch protection is admin-bypassable by
   design. Every one of them can tell you a check was green; none can prove to an auditor what
   entered the codebase, who or what put it there, and how it was verified — which at fleet scale
   is precisely a supply-chain question (§f).

3. **Neutrality is collapsing, and did so visibly on 14 August.** GitHub is Microsoft's; Origin is
   now SpaceX's; Entire is a venture platform whose business model centers on the agent-session
   data layer it hosts; Diversion is closed-source. The pattern extends down-stack: Wiz, the
   leading code-and-cloud scanner, closed into Google in March. Every frontier lab competes with,
   or is uncomfortable depending on, at least one of these owners. The loudest objection to Origin
   in public discussion was not about its engineering. The window for a neutral substrate is open
   now and will not stay open.

## d) Architectural tradeoffs, and why Google still runs Piper

Google is not on Piper out of inertia. A distributed VCS forces every client to reason about a
replica of history; at billions of lines that is physically untenable, and it forecloses what
Google actually monetizes internally: a single linear source of truth enabling atomic cross-cutting
changes, fine-grained per-path ACLs, and — decisively — tight coupling to an incremental,
content-addressed build/test graph so any change's blast radius is computable. The VCS is one organ
of a vertically integrated organism; git cannot replace it because git only replaces the organ.
Epic demonstrated the same conclusion from another industry: Lore ships alongside Horde, not
instead of it. Cursor demonstrated it a third time in August: Continuity's answer to git-at-scale
was not a better distributed protocol but a centralized log with git kept as a cache.

The lesson for agentic development: **the coordination problem arrives long before Google's scale
does**, because the writers are tireless and the verification is the bottleneck. The winning design
borrows the monorepo stack's centralized, virtualized, build-graph-integrated core while keeping
Git's open interface and offline-tolerant edges.

| System | Core model | Strengths | Costs / limits for agentic dev |
|---|---|---|---|
| **Git / GitHub** | Distributed; full replica; snapshot DAG; line-based 3-way merge | Universal; in every model's training data; enormous tool ecosystem | O(repo) operations; index/staging confuses agents; conflicts are workflow-blocking errors; no operation log; no native provenance |
| **Piper** (Google) | Centralized DB-backed store; CitC virtual FS; trunk-based | Billions of LOC; atomic cross-repo changes; fine-grained ACLs; one source of truth feeding the build/test graph | Requires connectivity + massive bespoke infra; closed; value comes from vertical integration, not the VCS alone |
| **Sapling / Mononoke / EdenFS** (Meta) | Centralized server, lazy virtual checkout; UX decoupled from storage format | Ops scale with working set, not repo size; proved Git can be a facade over different internals | Server + VFS never fully productionized externally; ecosystem still keys off GitHub |
| **Continuity** (Cursor) | Centralized WAL in object storage; git on local NVMe as cache; CAS instead of consensus | Linearizable pushes without a consensus protocol; linear read scaling; no bespoke object format to maintain | Storage only; single-tenant design center; numbers unreproduced outside Cursor |
| **Jujutsu** (jj) | Git-compatible backend; working copy is a commit; operation log; first-class conflicts | Universal undo; conflicts commit-able and resolvable later — the best change model available for agents | Client-side only; no server/collaboration layer |
| **Lore** (Epic) | Centralized server-of-record; content-addressed Merkle revisions; chunk dedup; lazy materialization; open spec | Binary-scale payloads native; open spec invites third-party implementations | No agent-native change model; no intent/evidence/provenance semantics |

## e) The agent harness boundary: the most contested interface in the stack

Any credible position on agent-era version control must answer a question the industry has barely
articulated: **where does the agent harness end and the development substrate begin?** By "harness"
we mean the runtime around the model — Claude Code, Codex CLI, Gemini CLI, OpenHands, Devin,
Cursor's agents — the layer that assembles context, plans, invokes tools, sandboxes execution, and
orchestrates subagents.

**The interface is neither clear nor static — it is drifting, and drifting in one direction.** For
thirty years the editor/VCS/CI boundary was stable because a human was the integrator between the
layers. Agents dissolve that boundary because the harness is now the integrator, and every harness
is discovering that the substrate beneath it lacks the primitives agentic work requires. So each
builds them privately: checkpoint-and-rewind via shadow repositories, session persistence and
resumption, memory files and context-loading conventions, multi-workspace orchestration atop git
worktrees, ad-hoc retry-and-rebase conflict handling. Each of these is a version-control primitive,
reinvented per-harness, invisible to the repository's history, and incompatible with every other
harness. The drift now extends to *governance*: harness vendors ship org-managed settings,
credential isolation and network-egress policy as per-harness enterprise features — administrative
control accumulating in the layer with the least visibility into what actually landed.

**Left alone, this drift is the default future, and it is a bad one.** Provenance fragments: an
enterprise running three harnesses gets three incompatible audit trails, none complete. Work
becomes non-portable: a task started in one harness cannot be resumed, reviewed, or verified in
another. And the harness becomes the lock-in point — precisely the vertical-integration play a
harness vendor with forge ambitions is positioned to make.

**The precedent is OpenTelemetry, not LSP.** Earlier versions of this brief reached for LSP, and
that was the wrong analogy: LSP standardised a *request/response interface* between two pieces of
local software, whereas what is fragmenting here is *emitted state that outlives the process and
must be correlated across vendors* — which is the telemetry problem exactly. OpenTelemetry won not
by making tools talk to each other but by standardising the record so any backend could consume it.
That is the shape ADP needs, and it is the shape that makes mirror mode strategic: a substrate that
can be *additive* before it is *authoritative* adopts the way a tracing standard adopts.

**The protocol layer just conceded the ground, which is the best adoption news in this brief.** The
Model Context Protocol's [2026-07-28 revision](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
removed protocol-level sessions and the `Mcp-Session-Id` header outright, instructing implementers
that "servers that need cross-call state use explicit, server-minted handles passed as ordinary
tool arguments." It simultaneously deprecated its own Logging feature in favour of OpenTelemetry
and added a reverse-DNS **extensions framework** for capabilities outside the core. Read plainly:
the protocol every major harness already speaks has formally declined to own agent state, pointed
at exactly the server-minted-handle shape ADP implements, and provided a namespace to publish in.
**ADP as a registered MCP extension is a namespace registration, not a foundation** — the cheapest
standardisation path this project has ever had.

Meanwhile GitHub standardised the *input* side: Agent Plugins reached GA on 12 August, and
AGENTS.md-class conventions are spreading fast. Input conventions are converging. **What an agent
did, and the evidence for it, is standardising nowhere.**

| Concern | Harness (policy) | Substrate (state & truth) |
|---|---|---|
| Context | Decides what to load, when, for which task | Versions the artifacts; serves them; records what was loaded |
| Memory | Decides what to remember and when to recall | Stores, versions and audits it |
| Workspaces | Requests forks; schedules attempts | Owns lifecycle: forking, isolation, GC |
| Checkpoints / undo | Decides when to checkpoint and when to rewind | Owns the operation log; makes undo durable |
| Conflicts | May supply the resolution agent | Represents the conflict; records resolution + evidence |
| Verification | Decides which evals matter for the task | Runs the gate; binds evidence at landing |
| Identity | Presents agent credentials | Verifies, signs, and anchors provenance |

**The harness is the brain and hands; the substrate is the world and the ledger.** Harnesses should
compete furiously on planning, context engineering and model quality — and should not be able to
compete on owning your history.

**The success scenario, concretely:** a task begun in Claude Code is checkpointed through ADP,
resumed in another harness, reviewed in a third-party UI, and landed through a gate — with one
continuous, signed history of intent, changes and evidence across all of them. Harness vendors
delete their shadow-VCS code the way editors deleted their per-language parsers. That — not a
forge, not a hosting business — is the standard worth building, and it is only credible if it is
neutral, open, and co-designed with the labs whose harnesses must adopt it.

## f) Enterprise controls and supply-chain security: the trust plane

The buyers who will deploy agents at scale — and the labs selling harnesses into them — treat a
specific control checklist as a precondition of purchase: dependency vulnerability management,
secret scanning with **push protection**, SAST integration, branch/land protection that admins can
enforce org-wide without per-repo opt-outs, audit-log export, and SSO/SCIM. Buyer-side
AI-governance surveys add agent-specific line items: evidentiary audit trails, approval-checkpoint
granularity, kill switches, model change control, and ISO/IEC 42001 or SOC 2 attestations. The
regulatory clock is synchronized with procurement: the EU Cyber Resilience Act's
vulnerability-reporting obligations begin **11 September 2026** — now weeks away, with ENISA's
reporting platform due operational the same day — and full obligations including machine-readable
SBOMs follow in December 2027.

**The agent era does not just inherit the supply-chain threat model; it rewrites it.**

- **Dependency risk moves at machine rate.** Frontier models hallucinate package names at measured
  rates of ~4.6–6.1%, and the hallucinations are *predictable* — 43% recur on every run — which is
  what makes **slopsquatting** an economic attack rather than a curiosity. It has escalated to
  adversarial triggers that make an agent hallucinate an attacker-chosen dependency, chained with
  prompt injection into RCE. Agents demonstrably skip the verification steps a suspicious human
  might perform.
- **Secrets leak at machine rate.** Commits co-authored by AI tools leak secrets at roughly **twice**
  the GitHub-wide baseline; ~29M new hardcoded secrets hit public GitHub in 2025 (+34% YoY), with
  AI-service credential leaks up 81%.
- **The build system is the attack surface — and signing it is not enough.** The Shai-Hulud worm
  lineage escalated on **4 August 2026** into **ChainDrop**, which poisoned 444 packages and 2,212
  versions in under four hours. Its significance for this brief is not its scale but its
  cryptography: the attacker compromised a maintainer's GitHub account, pushed release commits, and
  let the projects' own workflows publish through npm's OIDC Trusted Publishing — so **the
  malicious versions carried valid SLSA provenance attestations and were indistinguishable from
  legitimate releases by any automated provenance check.** Build provenance answers "did this come
  from the declared pipeline?" It cannot answer "should this have been allowed in?" That question
  belongs to an admission decision, and binding attestation to *the landing decision* rather than
  to the build is the difference ADP exists to make.
- **The agent itself is an attack vector.** The Nx "s1ngularity" compromise weaponized locally
  installed AI CLIs for reconnaissance and secret discovery; MCP tool-poisoning studies show >60%
  attack success on popular agents, with more-capable models often *more* compliant with poisoned
  metadata.

**Why the incumbent control shape doesn't survive contact.** GitHub's controls were designed for
human pace: nightly scans, alert dashboards, bot-authored PRs — detection after admission,
remediation as suggestion. Three structural mismatches. **Client-side prevention doesn't bind
agents**: pre-commit hooks are advisory (`--no-verify` is one token away), so the enforcement point
must be server-side admission. **Alert-then-triage assumes a human queue**: agents need
admission-time verdicts as typed, machine-readable objects they can act on *in-trajectory* — a
policy violation handed back to the agent that caused it, with the evidence attached, is
remediation at machine speed. And **remediation is the actual product**: a vulnerability becomes an
*intent* dispatched to the fleet, with candidate sets applying N remediation attempts and the gate
selecting the winner.

**The architecture is the control plane enterprises are asking for.** An eval-gated landing *is* an
admission controller; extending the gate vocabulary from "tests pass" to "supply-chain policy
holds" is schema, not new machinery. Five build items, of which the first three now ship:

1. **Org policy plane** *(shipped)*. Two-level resolution: an org-level, admin-owned,
   non-bypassable floor composed with repo-level `adp.yaml`. Policy changes are themselves signed,
   versioned changes with provenance — *"who loosened which gate, when, citing what"* is a history
   query, which no incumbent can answer. Includes the fleet kill switch.
2. **Attestation-native evidence** *(shipped)*. Evidence bundles serialize as in-toto/DSSE
   envelopes with SLSA-shaped provenance predicates, and an SBOM is emitted per landed change as
   ordinary evidence.
3. **Push protection at the receive path** *(shipped)*. We own the wire — git receive runs behind
   our middleware — so blocking secrets *before they enter history* is architecture, not product.
4. **Dependency admission** *(shipped for npm; breadth is the open work item)*. Lockfile diffs are
   first-class gate inputs: registry existence, age/cooldown windows, OSV and OpenSSF
   malicious-packages lookups, provenance checks, typosquat and hallucination heuristics, with
   unknowns quarantined to supervisor approval.
5. **Identity-aware risk tiers** *(designed)*. Provenance binds author identity (human or agent,
   model, session); policy can price it — unattended-agent changes to sensitive paths demand
   stricter gates, human attestation, or both.

**What we refuse to build: scanners.** SAST, SCA, secret-detection engines and vulnerability
databases are deep, fast-moving markets consolidating under players we cannot and should not
out-scan. We ship the **integration surface**: scanner-as-gate adapters (any CLI scanner drops in —
SARIF/JSON out, evidence attestation in), the pre-receive provider API, and public feeds as data
sources. Wiz's absorption into a hyperscaler makes scanner-neutrality the same argument as
harness-neutrality — the substrate must not privilege any vendor's scanner, including its own.

| Control | Incumbent shape | Agent-native shape (ADP trust plane) |
|---|---|---|
| Secret scanning + push protection | Repo/org setting; client hooks advisory | Pre-receive gate on the path we own; typed verdict returned to the authoring agent; org floor non-bypassable |
| Dependency vulns | Nightly scan → alert → bot PR | Admission gate on lockfile diff; remediation dispatched as intents |
| Code scanning (SAST) | App/Action per repo; SARIF → alert queue | Scanner-as-gate adapter; findings land as signed attestations, projected as check-runs on the compat plane |
| Branch protection | Per-repo rules; **admin-bypassable**; opaque to agents | Org ∧ repo resolution; policy changes signed and history-queryable; verdicts are typed objects |
| Audit log | Separate export product | The operations spine *is* the audit log — signed provenance attached at write time |
| SBOM / compliance | Bolted-on export tooling | Per-land attestation; CRA/42001 artifacts as a byproduct |
| Kill switch | Token revocation, manual and scattered | One org-policy operation: freeze landings, revoke agent identities, expire workspaces |

<sub>*Sources for §f: package-hallucination cohort study ([arXiv:2605.17062](https://arxiv.org/abs/2605.17062)); slopsquatting field data ([Socket](https://socket.dev/blog/slopsquatting-targets-across-frontier-llms), [Aikido](https://www.aikido.dev/blog/slopsquatting-ai-package-hallucination-attacks)); HalluSquatting escalation ([Xygeni](https://xygeni.io/blog/slopsquatting-evolution/)); agents skipping package verification ([TechTimes](https://www.techtimes.com/articles/319457/20260701/ai-coding-agents-skip-package-verification-attackers-are-exploiting-it.htm)); secret-leak telemetry ([byteiota](https://byteiota.com/github-secret-scanning-june-2026-push-protection-gets-wider/), [GitHub changelog](https://github.blog/changelog/2026-06-17-secret-scanning-updates-june-2026/)); Shai-Hulud lineage ([Microsoft](https://www.microsoft.com/en-us/security/blog/2025/12/09/shai-hulud-2-0-guidance-for-detecting-investigating-and-defending-against-the-supply-chain-attack/), [Picus](https://www.picussecurity.com/resource/blog/mini-shai-hulud-the-npm-supply-chain-worm-explained)); **ChainDrop and its valid-provenance property** ([BleepingComputer](https://www.bleepingcomputer.com/news/security/massive-chaindrop-npm-supply-chain-attack-infects-hundreds-of-packages/), [Zscaler ThreatLabz](https://www.zscaler.com/blogs/security-research/tracking-shai-hulud-inside-chaindrop-npm-worm), [StepSecurity](https://www.stepsecurity.io/blog/chaindrop-npm-worm), [Sangfor](https://www.sangfor.com/farsight-labs-threat-intelligence/cybersecurity/chaindrop-npm-supply-chain-attack-trusted-provenance)); MCP threat data ([The Hacker News](https://thehackernews.com/2026/06/microsoft-warns-poisoned-mcp-tool.html), [MCPTox](https://arxiv.org/pdf/2508.14925)); OSV/malicious-packages ([OpenSSF](https://openssf.org/blog/2026/05/20/detecting-malicious-packages-using-the-osv-api/)); CRA timeline ([European Commission](https://digital-strategy.ec.europa.eu/en/policies/cra-reporting)); Wiz close ([Google](https://blog.google/innovation-and-ai/infrastructure-and-cloud/google-cloud/wiz-acquisition/)); agent identity standards ([Stacklok](https://stacklok.com/blog/agentic-identity-explained-how-to-apply-spiffe-and-relationship-based-authorization-to-ai-agents-in-2026/)).*</sub>

<sub>*Sources for §c and the workload thesis: Cursor Continuity ([Git at any scale](https://cursor.com/blog/git-at-any-scale)); Origin's open beta and GitHub-as-source-of-truth ([Cursor changelog](https://cursor.com/changelog/origin-code-hosting)); the SpaceX/Anysphere close ([CNBC](https://www.cnbc.com/2026/06/16/spacex-spcx-cursor-acquisition-ipo.html)); MCP's session removal and extensions framework ([spec changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)); autonomous-merge volume ([Mergify, State of Merge Queues 2026](https://mergify.com/reports/state-of-merge-queues-2026)); agent-PR outcomes and failure causes ([MSR '26, arXiv:2602.00164](https://arxiv.org/abs/2602.00164)); agent-PR co-activity and conflict rates ([arXiv:2607.04697](https://arxiv.org/abs/2607.04697)); held-out-versus-visible saturation ([SpecBench, arXiv:2605.21384](https://arxiv.org/abs/2605.21384)); fan-out cost, our own arm 3 ([`bench/README.md`](../bench/README.md)).*</sub>

## g) What it costs to remember everything *(new in v6)*

A substrate that versions intent, trajectories and evidence alongside code takes on a storage
profile unlike a VCS's, and no entrant in §c has costed it in public. We have now costed ours, from
**1,930 real agent trajectory events** captured in our own benchmark runs rather than from
estimates.

| Unit | Measured size | Composition |
|---|---|---|
| Trajectory event | **~1.6 KB** | ~1,270 B heap plus ~340 B across six indexes |
| Landed change | **~12 KB** | of which **~8 KB is the SBOM**, re-emitted in full on every merge |
| Agent session | **~2 MB** | 500 events plus checkpoints — but nothing bounds the payload, and the industry anchor for long runs (85 KB/turn) puts the same session at **43 MB** |
| 20 agents, one month | **3.5–74 GB** | the 20× spread is the unbounded-payload range, not measurement error |

Three findings generalize past our implementation, and they are the reason this is a section rather
than a footnote.

**Derived evidence dominates, and most of it is redundant.** Two-thirds of the bytes in a landed
change are an SBOM whose contents are identical to the last one, made un-dedupable by a fresh UUID
and timestamp per emission. Any substrate that emits per-land attestations will find the same
thing: **the compliance artifact is the storage bill**, and determinism is worth more than
compression.

**Compression does not arrive on its own.** Per-row compression of our real corpus achieves 1.83:1
while whole-corpus achieves 5.5:1 — and 93% of rows fall below Postgres's TOAST threshold, so they
are not compressed at all. Trajectory data is enormously self-similar (92.7% of input tokens across
our benchmark trials were cache reads — the same context, stored again per event) and realising
that similarity requires batching across rows, which is a storage-architecture decision, not a
column type.

**Verifiability and garbage collection are in direct tension.** You cannot delete what an
attestation commits to without invalidating it. The resolution is that attestations commit to
**digests, never payloads** — which our checkpoint state already does and our SBOMs do not — so the
hash chain and the operation log are permanent while payloads tier or expire beneath them.
Verification then gains an honest third state alongside pass and fail: *verified, payload not
retained*. Rekor v2 is the precedent: the log publishes commitments, and clients persist proofs.

The position that follows, and that we are building toward: **four planes, one namespace.** Git for
source; Postgres for the transaction, the indexes and the typed projection; a content-addressed
object store for bytes; columnar storage for audit analytics when query patterns justify it.
Retention is org policy expressed in the same instance ∧ org ∧ repo mechanism as every other
policy, with a promote-on-reference rule — anything an eval, a selection, an attestation or a human
referenced is kept. **"One store and one history" was always a claim about the namespace, not the
engine**, and stating it as an engine claim — as earlier versions of this brief did — is not
survivable.

Honest sequencing, held to the same standard as everything else here: the cheap fixes come first
(index the operation log for the queries actually run against it, bound the payloads, make the SBOM
deterministic), then a deterministic storage-growth benchmark, and only then the object-store
split. Until that benchmark publishes, the numbers above are a model calibrated on real data, and
the architecture is a position rather than a result.

## What we will build

Our center of gravity sits deliberately up the stack: **commoditize what the market is converging
on; own what is uncontested.**

**Layer 3 — Verification fabric (the lead).** A gate runner executing declared commands in isolated
containers, producing signed evidence bundles, with landing gated on a two-level policy. When
agents write most of the code, verification — not authoring — is the throughput constraint. The
uncontested part is not the gate; §c observation 2 is now explicit that gates are ordinary. It is
the **non-bypassable, attested, policy-bound** gate whose verdict, inputs and evidence are one
signed record.

**Layer 1 — Change model.** Typed changes carrying intent, evidence and signed provenance; an
append-only operation log written in the same transaction as every mutation; undo; candidate sets;
semantic history query. This schema — not storage — is where our defining IP lives, published as
the ADP open specification designed for multi-vendor implementation.

**Layer 0 — Store: interoperate, don't reinvent.** Real git object stores, driven by the real `git`
binary, with the domain model in Postgres beside them. We evaluated building on Lore's open spec
and did not: the gap analysis did not justify the dependency, and Continuity's August result is
strong independent evidence that keeping real git as the object layer is the right call. §g
describes where bytes go as volume grows.

**Layer 2 — Interfaces.** Full git wire-protocol support and a pragmatic GitHub-API shim that real,
unmodified `gh` drives in CI; the native ADP surface over REST and MCP (17 tools today) as the
proposed standard; a supervision UI where humans review intent and evidence.

**The trust plane (cross-cutting).** The org policy engine, attestation-native evidence, push
protection at the receive path, dependency admission, and the scanner-as-gate integration surface.
Ships as schema, policy engine and seams — never as a first-party scanner (§f).

## Where this stands (August 2026)

The reference implementation lives in this repository (TypeScript · Fastify · Postgres · the real
`git` binary for all plumbing; Apache-2.0), built against the plan of record in
[`docs/pragmatic_mvp.md`](pragmatic_mvp.md) — whose bet is that the fastest route to the standard is
a server an **unmodified** agent can use instead of GitHub, with zero configuration beyond `GH_HOST`
and a token. Status is in [`ROADMAP.md`](../ROADMAP.md); the backlog is in [`PLAN.md`](../PLAN.md).

**Working today, verified in CI end-to-end.** Git smart-HTTP delegated to `git http-backend` behind
token auth. The GitHub-shaped REST core loop and GraphQL served from GitHub's real published SDL,
both validated against the real, unmodified `gh` binary in CI — including `gh pr checks` reporting
each gate as a status context linked to its evidence bundle. Typed **changes** binding a git commit
to intent and provenance, Ed25519-signed. An append-only **operation log** written in the same
transaction as every mutation, with undo and history query by actor, verb, date and path.
**Candidate sets.** DSSE-signed in-toto evidence bundles produced by a real gate runner that
executes in isolated containers (network-deny, dropped capabilities, no host mounts, no ambient
secrets, resource caps) and holds no database credential. **Mirror mode**, so ADP can be additive
before it is authoritative. Multi-tenant orgs with an isolation matrix enforced on every plane, a
two-level policy plane with an org console, per-org quotas including a storage ceiling, audit-log
export reconciled row-for-row against the operation log, OpenID Connect login mapped onto
identities, a Helm chart and Compose path verified by installing on a throwaway cluster, and a
published wire contract at version 0.5.0 that a downstream consumer generates its client from.

**Not yet built, stated plainly.** SCIM provisioning — OIDC login ships, but SCIM is deferred by
decision rather than blocked, parked until a procurement conversation demands it. Dependency
admission beyond npm. The storage architecture in §g beyond its cheapest fixes — the per-org
storage *quota* ships, so growth is now bounded and measured, but the four-plane split is still a
position rather than a build. A hosted preview, which is blocked on a budget decision rather than
on engineering. And the three experiments named below.

**Measured, not asserted.** Three benchmark arms are published. Merge contention under concurrent
land is deterministic and runs in CI. The three-way cost comparison found our native plane 1.7×
the cost of our own compatibility plane — the uncomfortable result that made A1 an open decision
rather than a settled position. And the fan-out-versus-serial arm, pre-registered, 20/20 trials
verified, found swarm topology cost **3.6× the tokens and wall clock and 2.8× the tool calls** of a
single agent for **no measurable quality difference** — on two tasks both solvable in one pass,
which the arm's own report names as the limit on what it can conclude.

## Why frontier labs specifically — and the ask

Each lab is independently rebuilding fragments of this stack: sandboxed repo services, merge
heuristics, eval gates, trajectory logging, harness-private checkpointing. Meanwhile the emerging
alternatives are owned by parties every lab competes with or is uncomfortable depending on, and at
least one intends to monetize the behavioral data your agents generate. Frontier labs are the only
actors with both the incentive and the leverage to force a neutral standard: you build the dominant
harnesses, and you control what models are post-trained on. An open substrate turns duplicated
internal cost into a common target, and produces the provenance-plus-evidence layer (who, what,
why, and *how verified*, for every change) that safety cases, regulators and enterprise buyers will
demand. There is a commercial symmetry too: every lab now sells its harness into enterprises whose
procurement gate is the §f checklist — a neutral substrate that answers that checklist once, with
signed evidence, is how every harness inherits the answer instead of each lab rebuilding it.

**The ask:** two to three design partners on (1) the ADP specification — the native agent API and
change schema, co-designed against your harnesses, with MCP extension registration as the concrete
first step; (2) the evidence and attestation format, explicitly supply-chain-aware; (3) a joint
post-training corpus for the native surface, conditional on the native-plane experiment below
justifying it; and (4) the supply-chain and governance checklist your enterprise customers already
hand you, co-designed into the org policy plane. We contribute the reference implementation under
Apache-2.0; governance moves to a neutral foundation once two independent implementations exist.

---

# Appendix A: Open decisions

The brief above states positions with conviction. This appendix states the three questions we have
*not* answered — genuinely undecided, consequential enough that different answers produce different
roadmaps, and answerable by something we can measure or ask. Everything else that used to live here
has either been settled by our own code and measurements (Appendix B) or become a position with a
tripwire (Appendix C).

## OD-1. What is the native plane for, and what does it cost?

**The question.** We bet that labs will post-train models against a native agent surface, making
the Git facade an off-ramp rather than the main road. Our own benchmark contradicts us: the native
MCP plane cost **$0.1435/trial** against **$0.0848** through `gh` against the same server. The
cause is legible — no proposal-open MCP tool, so the agent pays a round-trip `gh` bundles — but
until it is fixed and re-measured, we are advocating a surface we have measured as more expensive
than the one it replaces.

**Why it is open.** This is the only item where we hold a contradicting first-party number, which
converts an argument into an experiment.

**What we owe.** Close the tool-surface gap; re-run at study scale; add the two arms the original
question named — task-completion reliability over *long* trajectories, and novel-CLI-from-docs as a
third condition. **It blocks** the native-versus-shim investment split and the credibility of the
post-training-corpus ask.

## OD-2. Can a gate detect an agent that has satisfied its own tests?

**The question.** The small-N concurrent base case's binding risk is not merge contention. It is
**self-graded evidence**: agents iterate until they believe the work is done, and the belief is
measurably untrustworthy — every frontier agent saturates the visible test suite while the held-out
gap grows ~28pp per 10× code size, and 15.3% of agent-authored fixes are incorrect *under a green
build*. If a gate cannot distinguish satisfying the tests from doing the work, then "eval-gated
landing" is CI with better signatures, and the differentiator collapses back to provenance alone.

**Why it is open.** We shipped one half — statistical land criteria, with a Wilson-lower-bound
confidence gate and quarantine recorded as an operation — and none of the other half. Our own land
policy currently accepts an author approving their own proposal, which is the degenerate case of
exactly this problem.

**What we owe.** Author-independent approval, and a held-out-versus-visible benchmark arm of the
same shape as the two that have already run. This is the deepest open technical problem in the
brief and probably its most defensible contribution; it should be published as research.

## OD-3. Will a harness vendor adopt, and what is the minimum portable slice?

**The question.** The whole §e argument depends on harnesses adopting a neutral substrate rather
than deepening their private ones. The counter-scenario is vertical integration winning. A second
failure mode is a *partial* standard: harnesses adopt checkpoints (cheap) but keep memory and
orchestration state proprietary (where differentiation lives), leaving an audit trail that looks
complete and is not — arguably worse than no standard.

**Why it is open.** It is the least-evidenced claim in this brief. We have had zero conversations
with harness teams, and our cross-harness resume path has only ever been exercised against one
harness identifier.

**What we owe.** Register the MCP extension; build the cross-harness resume demo; take it to two
harness teams. **Why it is decisive:** five of the six positions in Appendix C name the same
missing event as their tripwire — a first design partner. OD-3 is the item that produces one.

# Appendix B: Settled, and what settled them

Nine questions this brief used to carry are closed. Every one was settled by building or measuring,
not by argument — which is the strongest claim this document makes about its own method.

| Question | Resolution | Settled by |
|---|---|---|
| Depth of GitHub compatibility | A pragmatic partial shim is sufficient; real unmodified `gh` drives the full loop | Shipping it, and pinning it in CI |
| Bespoke store vs. Lore vs. git objects | Real git objects plus Postgres. Lore not adopted | Building it; Continuity is independent corroboration |
| Jujutsu: adopt, fork, or reimplement | Neither — the ADP verb set over plain git | Cut in the plan of record; never missed |
| Structural (AST) merge vs. agent-mediated | Neither is needed: the gate means merge mistakes must be *caught*, not prevented | Cut; the gate does the work |
| Is agent memory a merge problem? | No. It needs the same audit trail and provenance, not the same write path | Narrowed by implementation |
| The monorepo assumption | Not load-bearing at this scope; mirror mode makes ADP additive first | Mirror mode shipping |
| Wide fan-out vs. long serial sessions | **Small-N concurrent with one integrator is the base case.** Fan-out cost 3.6× for no measurable quality gain | Our own pre-registered arm, plus market evidence |
| Does merge contention bottleneck fleets? | Not at the ref level. But contention is real and lands elsewhere — 79.4% of agent PRs are temporally co-active, and the largest single cause of death is *another PR fixing the same thing* | External measurement, correcting our earlier reasoning |
| Erosion of the PR shape | Survivable by construction: evidence and history hang off changes and operations, never off `proposal` | Schema discipline, audited |

# Appendix C: Positions and their tripwires

Positions we hold, what would change each, and whether that tripwire is currently tripped.

| Position | What would change it | Tripped? |
|---|---|---|
| **Centralized source of truth** with offline-tolerant edges. CRDTs guarantee convergence, not correctness, and code demands correctness | An air-gap or data-residency requirement from a real partner | No |
| **Signed provenance on every change**, aligned with WIMSE/Agentic-JWT rather than invented | A lab refusing to persist traces for IP, safety or discoverability reasons — the schema would need graduated disclosure, which the opaque-payload seam already anticipates | No partner yet |
| **Implementation-first standardisation**, spec published early, conformance suite as the hedge. If the incumbent moves first, we become the conformance layer it is pressured to comply with | GitHub shipping attested, non-bypassable evidence binding — not merely more gates | No. Agent Plugins standardised the input side only |
| **Adapters, never scanners.** One bundled engine (secret detection at the receive path) and no first-party SAST/SCA | Procurement demanding batteries-included baseline scanning | **Partly** — on breadth, not on principle: dependency admission and SBOM emission are npm-only |
| **Two-level policy resolution inside the substrate**, org floor ∧ repo file, both signed and versioned | An enterprise insisting its existing policy engine stays the source of truth — ADP would become an enforcement point that binds external decisions into the signed land record | No |
| **Compliance as a byproduct**, not a product: we guarantee the evidentiary substrate, and GRC tooling renders reports from it | Auditors rejecting attestation envelopes and demanding certified report formats | No |

---

*Published for open discussion; the primary audience remains technical leadership at frontier labs
and the teams building agent infrastructure. Positions in the main brief are current convictions;
Appendix A names what we have not decided, and Appendix C names the evidence that would change what
we have.*
