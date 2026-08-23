# Repository positioning review and description proposal

**Audience:** prospective developers evaluating ADP  
**Scope:** the repository's first impression, value proposition, and path to a first successful test drive  
**Review date:** 2026-08-23

## Executive recommendation

Use this as the repository description:

> **A GitHub-compatible forge for AI coding agents that binds every change to signed intent, provenance, and verification evidence.**

This is the strongest description because it answers the three questions a developer asks while scanning a repository:

1. **What is it?** A forge, not an agent framework or a Git wrapper.
2. **Why should I care?** It makes agent-authored changes auditable by binding context and verification to the change.
3. **Can it fit my workflow?** “GitHub-compatible” signals that existing `git`, `gh`, and CI integrations are the on-ramp.

The description is 127 characters, fits comfortably within GitHub's repository-description limit, avoids unexplained acronyms, and leads with the category rather than the implementation.

### Short alternative

If a tighter description is preferred:

> **A GitHub-compatible forge with signed provenance and verification evidence for every agent-authored change.**

### Enterprise-oriented alternative

If the primary audience becomes platform engineering and security teams:

> **A self-hosted, GitHub-compatible forge for governing agent-authored code with policy-gated merges and signed evidence.**

## Positioning foundation

### What ADP is

ADP is an open-source, self-hosted software forge designed for AI coding agents. It serves Git smart HTTP, a compatible subset of GitHub's REST and GraphQL APIs, and an agent-native API exposed through REST and MCP. Git remains the source of code truth; PostgreSQL stores signed change records, evidence, provenance, policy, and the append-only operation log.

The clearest category is **agent-native software forge**. “Protocol” is accurate in the expanded project name, but it is not sufficient as the category: the repository contains a runnable server, CLI, gate runner, UI, deployment artifacts, and compatibility APIs—not only a specification.

### Why it is valuable

For an individual developer, ADP offers:

- Familiar tools: existing `git` and `gh` workflows remain usable.
- Durable agent context: intent, model/harness/session provenance, and verification survive outside a vendor-specific chat transcript.
- Inspectable proof: gate results are stored as signed attestations rather than ephemeral CI output.
- Recovery primitives: the native API includes operation history, checkpoints, sessions, workspaces, candidate sets, and guarded undo.

For an enterprise platform or security team, ADP adds:

- Merge-time enforcement: instance, organization, and repository requirements are additive and fail closed.
- Supply-chain records: changes and evidence are signed, attributable, and queryable.
- Tenant controls: organizations provide policy, quota, isolation, kill-switch, and audit boundaries.
- Deployment control: both Helm and Docker Compose self-hosting paths are included.

The most defensible differentiator is not simply “Git for agents.” It is **enforceable binding of intent and verification evidence at merge time while preserving GitHub-compatible workflows**.

## Repository review

### What already works well

1. **The opening names the mechanism precisely.** The README immediately explains that ADP speaks GitHub protocols and records why and how a change was verified.
2. **The product thesis is unusually rigorous.** The “Why” section distinguishes evidence from an agent's own assertion that work is complete and explains why the record must outlive a particular harness.
3. **Compatibility claims are concrete.** The `gh` matrix separates functional, partial, and unsupported commands instead of implying complete GitHub parity.
4. **Security boundaries are explicit.** The README states that the server attests gate results but does not execute them, and the self-hosting guide explains the runner's Docker-socket risk.
5. **Enterprise concerns are substantive.** Policy floors, org isolation, quotas, audit export, OIDC, observability, and signed provenance are implemented concepts rather than generic “enterprise-ready” language.
6. **The repo supports serious validation.** It contains schemas, an OpenAPI document, unit/integration/e2e tests, conformance coverage using an unmodified `gh` binary, and clean-environment automation.

### Where the first-time developer journey breaks down

#### 1. The category is not instantly scannable

“Agent Development-state Protocol” sounds like a wire specification, while the first sentence calls ADP “a version control and CI/CD server.” Later sections reveal a fuller product: forge, policy engine, evidence store, compatibility layer, runner, CLI, MCP server, and UI. A prospective developer must synthesize the category themselves.

**Recommendation:** consistently call ADP an **agent-native, GitHub-compatible software forge**, then explain the signed development-state record as its differentiator.

#### 2. The README optimizes for architectural conviction before evaluation

The README is comprehensive and technically credible, but a new visitor reaches runnable instructions only after the complete product model, policy system, compatibility matrix, native API, CLI, and UI. This serves an already-interested architect better than a developer deciding whether to spend ten minutes.

**Recommendation:** add a compact “Try ADP locally” path directly after the opening value proposition. Move the current deep explanation under a “How ADP works” section without deleting it.

#### 3. There is no genuinely minimal test drive

The documented source path requires PostgreSQL, configuration, migration, server startup, bootstrapping, and knowledge of how to create a repository and exercise the flow. The clean-machine path (`bootstrap`, `make up`, `make test-all`, `make down`) proves the project but is a full validation loop, not a product test drive. The production Compose path requires keys, a public hostname, DNS, and TLS because `gh` will not use an arbitrary plaintext host.

**Recommendation:** provide one copy/paste evaluation script that:

1. starts an ephemeral local ADP and PostgreSQL stack;
2. creates an admin identity, organization, token, and repository;
3. configures a local TLS hostname developers can use with `gh`;
4. clones a seeded repository;
5. pushes one change with intent and provenance;
6. reports a passing gate, opens a proposal, records an approval, and lands it; and
7. prints links to the change, evidence bundle, and operation log before offering cleanup.

The target should be **one command, under five minutes, and no cloud account**. Until that exists, label the current flow “Run the full local verification suite,” not “quickstart.”

#### 4. The first success state is not defined

A developer can start the server without seeing the product's unique value. A health check, clone, or UI load proves deployment—not ADP. The meaningful “aha” moment is a landed change whose intent, provenance, approval, and gate evidence can be inspected together.

**Recommendation:** define the test-drive completion criterion as:

> “I used normal Git/GitHub tooling to land a policy-compliant change, then inspected its signed evidence and provenance in ADP.”

#### 5. The messaging leads with implementation detail in places

Fastify, PostgreSQL, Ed25519, DSSE, and in-toto establish credibility, but they are supporting proof rather than the top-level benefit. Individually they do not explain why a developer should adopt a new forge.

**Recommendation:** use a progressive disclosure order: outcome → workflow fit → differentiator → architecture → exhaustive API/status detail.

## Recommended README opening

The repository description should be reinforced—not contradicted—by the first screen of the README. A future README revision could begin:

```markdown
# ADP — the agent-native software forge

ADP is a self-hosted, GitHub-compatible forge for AI coding agents. Keep using
`git`, `gh`, and existing CI integrations while ADP binds every change to its
intent, agent provenance, approvals, and signed verification evidence.

**Why ADP?** Agent transcripts are temporary and an agent saying “tests pass”
is not independent proof. ADP makes development context durable and enforces
your evidence requirements at merge time.

[Try it locally in under five minutes] · [How it works] · [Self-hosting]
```

This version makes the category, compatibility, benefit, and evaluation action visible without scrolling. The existing architectural introduction can follow it.

## Recommended repository metadata

- **Description:** A GitHub-compatible forge for AI coding agents that binds every change to signed intent, provenance, and verification evidence.
- **Website:** point to a dedicated quickstart once it produces the complete success state above; until then, link to the README rather than a generic landing page.
- **Topics:** `ai-agents`, `developer-tools`, `git`, `github-compatible`, `software-supply-chain`, `provenance`, `in-toto`, `mcp`, `self-hosted`, `devsecops`.

Avoid using `ci-cd` as the leading category. ADP receives and attests gate results and offers a separate runner, but it intentionally is not a general workflow-automation platform.

## Proposed follow-up work

Prioritized by effect on developer evaluation:

1. **P0 — Build the one-command test drive.** Make the differentiating change/evidence flow executable from a clean machine.
2. **P0 — Restructure the README's first screen.** Add category, value, familiar-tool signal, and a test-drive call to action before the architecture narrative.
3. **P1 — Add an evidence-flow diagram.** Show agent/`git` → change → external gate/runner → signed evidence → policy-gated land → operation log.
4. **P1 — Publish the repository metadata.** Apply the recommended description and topics in the repository host settings.
5. **P1 — Add evaluator paths.** Offer “individual developer,” “platform engineer,” and “security reviewer” routes with the shortest relevant material for each.
6. **P2 — Add a two-minute terminal recording.** Demonstrate unmodified `git`/`gh`, a rejected land without evidence, a successful land after a gate report, and the resulting evidence view.
7. **P2 — Measure the funnel.** Track quickstart starts, first push, first proposal, first gate, first land, and evidence-view completion; treat time-to-first-evidenced-change as the primary DevRel activation metric.

## Decision

Adopt the primary description:

> **A GitHub-compatible forge for AI coding agents that binds every change to signed intent, provenance, and verification evidence.**

It is specific enough to distinguish ADP, accessible to developers who have never heard the name, and faithful to what the repository implements today. The next DevRel investment should not be more conceptual documentation; it should be turning the existing capabilities into a single, disposable, end-to-end test drive.
