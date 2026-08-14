import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
  boolean,
  integer,
  bigint,
  doublePrecision,
  unique,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// M4-0 (docs/m4-readiness-review.md §4): the tenancy boundary every other M4
// item hangs off — scoped tokens, the org policy plane, quotas, audit export.
// `name` is unique because the backfill migration (drizzle/0018) synthesizes
// one org per distinct pre-M4 `repos.owner` string, and that mapping has to
// stay one-to-one for the backfill to be idempotent.
export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  // M4-2: the org policy plane generalizes the instance floor
  // (resolveLandRequirements, core/repo-policy.ts) from a two-way union
  // (instance ∧ repo) to three (instance ∧ org ∧ repo), additive-only same
  // as the existing two. An org's floor lives in a `policy.yaml` on this
  // repo's default branch (core/org-policy.ts) — reusing an ordinary repo,
  // not a new storage mechanism, is what makes "policy changes as signed
  // reviewable changes" (docs/m4-readiness-review.md) true for free: landing
  // a policy change already goes through the same intent→diff→evidence→
  // provenance path as any other change, because it *is* one. Null means
  // the org has designated no policy repo yet — an empty floor, not an error.
  policyRepoId: uuid("policy_repo_id").references((): AnyPgColumn => repos.id),
  // The blast radius decided in docs/m4-readiness-review.md §3: refuses every
  // land attempt for every repo in this org while set (core/land-policy.ts).
  // Deliberately does NOT block opening a new proposal — that's a stated,
  // narrower scope for this slice (see the M4-2 PR description); a proposal
  // sitting open-but-unlandable while the switch is active is a safe
  // intermediate state, landing is the consequential action.
  killSwitch: boolean("kill_switch").notNull().default(false),
  // M4-3: null means unlimited — the default for every org until an operator
  // sets one, same "absence is not a limit" convention `workspaces.expiresAt`
  // already uses. Storage quota is deliberately not here yet: it needs M4-8's
  // object store to meter against (docs/m4-readiness-review.md §4).
  maxRepos: integer("max_repos"),
  maxConcurrentWorkspaces: integer("max_concurrent_workspaces"),
  // M4-9d: same "null is unlimited" convention as the two quotas above,
  // checked against gate_jobs.status = 'running' across every repo in the
  // org (http-rest/gate-jobs.ts's claim route) rather than at enqueue time —
  // an org's queue can grow arbitrarily deep, this bounds how much of it
  // executes at once, which is what actually costs CPU/memory on the runner
  // fleet.
  maxConcurrentGateJobs: integer("max_concurrent_gate_jobs"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Membership is the only source of "is this identity in this org" — no role
// duplicated onto identities or tokens. `role` is deliberately two values
// rather than a permissions bitmask: nothing in M4's own scope (org-scoped
// tokens, the org policy plane) needs finer granularity yet, and an enum can
// grow later without a shape change.
export const orgMemberships = pgTable(
  "org_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => orgs.id),
    identityId: uuid("identity_id").notNull().references(() => identities.id),
    role: text("role", { enum: ["member", "admin"] }).notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.orgId, table.identityId)],
);

export const repos = pgTable(
  "repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    // NOT NULL since #89: M4-0's backfill synthesized an org per distinct
    // `owner` string and every create path since assigns one, so "a repo
    // with no org" stopped being a real state — and org isolation (#91)
    // needs to key every repo-scoped check off this column, which it can
    // only do if the column is always there. `owner` stays the compat-plane
    // URL identifier (`/api/v3/repos/{owner}/...`); this is the relational
    // backing underneath it, not a replacement for it.
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The tenancy key and the hottest lookup in the server (findRepo). The
    // uniqueness is the authority the create path's insert relies on (#89):
    // the pre-insert existence check is a fast path, not the guard, so two
    // concurrent creates of one owner/name can never make two rows for one
    // on-disk repo.
    uniqueIndex("repos_owner_name_idx").on(table.owner, table.name),
    // A Postgres FK creates no index of its own; org_id is in the gate-job
    // claim hot path, the audit export, and all three quota counts.
    index("repos_org_id_idx").on(table.orgId),
  ],
);

export const identities = pgTable("identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind", { enum: ["human", "agent"] }).notNull(),
  principal: text("principal").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Opaque bearer tokens, hashed at rest (scrypt). Doubles as git basic-auth password.
// harness/model/sessionId carry the agent provenance tuple (§4.4) when the
// token was minted for an agent session; null for human PATs.
export const tokens = pgTable("tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  identityId: uuid("identity_id").notNull().references(() => identities.id),
  // M4-1: additive to the three repo-level scopes below, not a replacement.
  // Null for every pre-M4 token and for one minted without an org — a token
  // with no org can still do everything its repo-level scopes allow, it just
  // never satisfies an org-scoped check (auth/plugin.ts requireOrgAccess),
  // which fails closed rather than defaulting to some org.
  orgId: uuid("org_id").references(() => orgs.id),
  tokenHash: text("token_hash").notNull().unique(),
  // sha256(token) hex, indexed — narrows authenticate() to (at most) one row
  // instead of scrypt-verifying against every unrevoked token in the table.
  // Not a substitute for tokenHash's scrypt verification, just a fast filter:
  // a lookup-key collision would still fail the scrypt check.
  lookupKey: text("lookup_key").notNull().unique(),
  scopes: text("scopes").array().notNull().default([]),
  harness: text("harness"),
  model: text("model"),
  sessionId: text("session_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revoked: boolean("revoked").notNull().default(false),
});

export const intents = pgTable("intents", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repos.id),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  source: text("source", { enum: ["issue", "task", "api"] }).notNull(),
  parentId: uuid("parent_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Per-repo sequential numbering, GitHub-shaped. Assigning `number` requires
// serializing on the repo row (see issues.ts) — Postgres won't do it for us.
export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id").notNull().references(() => repos.id),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    state: text("state", { enum: ["open", "closed"] }).notNull().default("open"),
    intentId: uuid("intent_id").references(() => intents.id),
    authorId: uuid("author_id").notNull().references(() => identities.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [unique().on(table.repoId, table.number)],
);

export const issueComments = pgTable("issue_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  issueId: uuid("issue_id").notNull().references(() => issues.id),
  authorId: uuid("author_id").notNull().references(() => identities.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// The defining record: diff (as a git commit, referenced not duplicated) +
// intent + provenance, signed. Git is the store; this is metadata beside it.
export const changes = pgTable(
  "changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id").notNull().references(() => repos.id),
    gitSha: text("git_sha").notNull(),
    intentId: uuid("intent_id").references(() => intents.id),
    workspaceId: uuid("workspace_id"),
    provenance: jsonb("provenance").notNull(),
    signature: text("signature").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // The hot dedup lookup every push does (http-git/hooks.ts's post-receive
  // recording) and the evidence-bundle read (core/evidence.ts) both filter on
  // exactly this pair — a sequential scan here is the first thing a mirrored,
  // multi-thousand-commit repo makes slow.
  (table) => [index("changes_repo_id_git_sha_idx").on(table.repoId, table.gitSha)],
);

// PR-shaped: the unit review and landing attach to. Numbered independently
// from issues for now — real GitHub shares one number sequence across both,
// which would need a shared counter across two tables; deferred as a known
// fidelity gap rather than scope-creeping this slice.
export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id").notNull().references(() => repos.id),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    headRef: text("head_ref").notNull(),
    headSha: text("head_sha").notNull(),
    baseRef: text("base_ref").notNull(),
    changeId: uuid("change_id").references(() => changes.id),
    candidateSetId: uuid("candidate_set_id"),
    state: text("state", { enum: ["open", "closed", "merged"] }).notNull().default("open"),
    authorId: uuid("author_id").notNull().references(() => identities.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
  },
  (table) => [unique().on(table.repoId, table.number)],
);

// Native-plane-only concept (docs/pragmatic_mvp.md §2.2, "the only MVP
// feature GitHub structurally cannot express"): N proposals fanned out
// against one intent, scored, and one selected. `proposals.candidateSetId`
// (added ahead of this table, schema.ts commit history) is how a proposal
// joins a set; this table is the set itself plus the resolution.
export const candidateSets = pgTable("candidate_sets", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repos.id),
  intentId: uuid("intent_id").notNull().references(() => intents.id),
  // M3: constrained from free text to the three policies core/candidate-sets.ts
  // actually implements. `manual` is an explicit select call; `first_green` takes
  // the first candidate whose land policy evaluates clean; `best_score` takes the
  // highest `score` gate result, breaking ties by earliest proposal number so a
  // benchmark run is reproducible rather than merely likely.
  selectionPolicy: text("selection_policy", { enum: ["manual", "first_green", "best_score"] })
    .notNull()
    .default("manual"),
  selectedProposalId: uuid("selected_proposal_id"),
  // A set is `open` until it resolves. Resolving lands the winner and reclaims
  // the losers' workspaces — D1's "GC the rest". Losing rows are never deleted,
  // only their refs reclaimed, because D1's whole point is that the 49 discarded
  // attempts stay queryable without polluting history.
  status: text("status", { enum: ["open", "resolved", "abandoned"] })
    .notNull()
    .default("open"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const reviews = pgTable("reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  proposalId: uuid("proposal_id").notNull().references(() => proposals.id),
  reviewerId: uuid("reviewer_id").notNull().references(() => identities.id),
  state: text("state", { enum: ["approved", "changes_requested", "commented"] }).notNull(),
  body: text("body").notNull().default(""),
  annotations: jsonb("annotations"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per gate report against a commit — the evidence bundle IS the
// `envelope` column (a signed DSSE envelope wrapping an in-toto Statement,
// core/dsse.ts); the other columns are a queryable projection of it, not a
// second source of truth. Multiple rows can exist for the same
// (repoId, gitSha, name) — a rerun — the most recent one wins when resolving
// land policy or a StatusCheckRollup; history is kept, not overwritten.
export const gateResults = pgTable(
  "gate_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id").notNull().references(() => repos.id),
    gitSha: text("git_sha").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["success", "failure", "pending"] }).notNull(),
    summary: text("summary").notNull().default(""),
    reporterId: uuid("reporter_id").notNull().references(() => identities.id),
    envelope: jsonb("envelope").notNull(),
    // Stable identifier for evidence that originates upstream rather than from
    // a POST to .../gates — currently a mirrored repo's GitHub Actions run
    // ("workflow_run:<id>", core/actions-ingest.ts). GitHub redelivers
    // webhooks, and the M2 exit criterion is *exactly one* evidence row per
    // completed run, so this carries a partial unique index and the insert
    // uses onConflictDoNothing: a redelivery is a no-op at the database level
    // rather than something application code has to remember to check.
    // Null for gates reported through the ordinary REST path.
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Every land-policy check (core/gate-results-lookup.ts) and evidence-bundle
  // read filters on (repo_id, git_sha), then narrows to `name` when resolving
  // a specific gate's latest verdict — same reasoning as `changes`' index.
  (table) => [
    index("gate_results_repo_id_git_sha_name_idx").on(table.repoId, table.gitSha, table.name),
    // M3's statistical land criteria (core/flake-stats.ts) ask a different
    // question of this table: the trailing N results for one *gate*, across
    // commits, newest first. The index above leads with repo_id and then
    // git_sha, so that query could only bitmap-scan on (repo_id, name) and then
    // **sort** every result the gate has ever produced — O(all history for that
    // gate) per evaluation, and land policy is evaluated twice per merge plus
    // once per candidate during a 50-way fan-out.
    //
    // Ascending rather than DESC on created_at deliberately: Postgres walks a
    // btree backwards just as happily, so this serves `order by created_at desc
    // limit n` as an ordered index scan without a sort node.
    index("gate_results_repo_id_name_created_at_idx").on(table.repoId, table.name, table.createdAt),
    uniqueIndex("gate_results_repo_id_external_id_idx")
      .on(table.repoId, table.externalId)
      .where(sql`${table.externalId} is not null`),
  ],
);

// Native-plane-only concept (docs/pragmatic_mvp.md §2.2: "Workspace | A
// branch adp/ws/<id> | Lifecycle, TTL, GC, isolation") — deliberately just a
// thin row around a real git ref, not a new storage mechanism. `branch` is
// the actual `refs/heads/<branch>` name; destroying a workspace deletes that
// ref (core/workspaces.ts) and sets destroyedAt rather than deleting the row,
// so the op log stays a complete history.
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repos.id),
  branch: text("branch").notNull(),
  baseRef: text("base_ref").notNull(),
  baseSha: text("base_sha").notNull(),
  createdById: uuid("created_by_id").notNull().references(() => identities.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  destroyedAt: timestamp("destroyed_at", { withTimezone: true }),
});

// An orchestrator's unit of assigned work — one Squad assignment, one fleet
// dispatch — spanning the N sessions the orchestrator spawns to do it. Sessions
// already carry "one agent's work across harnesses" (D2); a run is the level
// above, and it is the level an *eval* is meaningfully attached to: you do not
// evaluate one agent's turn, you evaluate whether the assignment was completed.
//
// `orchestrator` is opaque in exactly the way `sessions.harness` is — ADP never
// branches on its value. `externalRef` is the orchestrator's own id for the
// assignment, carrying a partial unique index so that re-opening a run after a
// crash resolves to the same row rather than forking the trajectory in two.
//
// The run closes against `finalGitSha`, and `envelope` is a DSSE-signed
// attestation binding that sha to every session's trajectory chain head
// (core/runs.ts). That binding is the point: it is what makes "this code came
// out of that trajectory" checkable rather than asserted.
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id").notNull().references(() => repos.id),
    // Required, unlike sessions.intentId. A run is the object an eval scores and
    // a gate reports on, and scoring work whose goal was never stated is how you
    // get a number nobody can interpret later.
    intentId: uuid("intent_id").notNull().references(() => intents.id),
    orchestrator: text("orchestrator").notNull(),
    externalRef: text("external_ref"),
    actorId: uuid("actor_id").notNull().references(() => identities.id),
    status: text("status", { enum: ["open", "closed", "abandoned"] }).notNull().default("open"),
    // What this run *was* — the vendor, the model, the tier an orchestrator
    // chose. Set at open and never afterwards, which is the whole point: the
    // run attestation covers them, so "this result came from gemini-flash" is
    // signed alongside the trajectory rather than annotated next to it. A
    // mutable label would be a claim about the past that the past cannot check,
    // so there is no route that writes one.
    labels: jsonb("labels").$type<Record<string, string>>().notNull().default({}),
    finalGitSha: text("final_git_sha"),
    // sha256 over every session's (id, harness, event count, chain head), sorted
    // by session id — one value naming the whole run's trajectory, stable to
    // recompute and cheap to compare across runs.
    trajectoryDigest: text("trajectory_digest"),
    envelope: jsonb("envelope"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    index("runs_repo_id_status_idx").on(table.repoId, table.status),
    index("runs_repo_id_intent_id_idx").on(table.repoId, table.intentId),
    uniqueIndex("runs_repo_id_orchestrator_external_ref_idx")
      .on(table.repoId, table.orchestrator, table.externalRef)
      .where(sql`${table.externalRef} is not null`),
  ],
);

// M3 (docs/m3-readiness-review.md §4, M3-1): a unit of agent work that
// outlives any one harness — the object D2 ("cross-harness portability") is
// about. `harness` is just an identifier the caller supplies; ADP never
// branches on its value, which is what makes the protocol harness-neutral
// rather than harness-aware.
//
// Per A18 (brief v5 appendix), sessions deliberately hang off `operations` and
// `changes` and never off `proposal` — proposals are a compat-plane shape that
// may erode, and evidence, provenance, and history must not erode with them.
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id").notNull().references(() => repos.id),
    intentId: uuid("intent_id").references(() => intents.id),
    // Null for a session nobody orchestrated — a developer checkpointing their
    // own work is still a session, and requiring a run for it would make the
    // orchestrated case the only supported one.
    runId: uuid("run_id").references(() => runs.id),
    harness: text("harness").notNull(),
    actorId: uuid("actor_id").notNull().references(() => identities.id),
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    status: text("status", { enum: ["active", "suspended", "resumed", "closed"] })
      .notNull()
      .default("active"),
    // The lineage link D2 turns into "one continuous history": set when this
    // session was created by resuming another. Self-referencing, so a chain of
    // resumes across three harnesses is walkable without a join table.
    resumedFromSessionId: uuid("resumed_from_session_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sessions_repo_id_status_idx").on(table.repoId, table.status),
    // Every run-scoped read (trajectory, stats, close, verify) starts by
    // gathering the run's sessions.
    index("sessions_run_id_idx").on(table.runId),
  ],
);

// The trajectory spine: every message, model call, tool execution, handoff,
// commit, and test result an agent produced, appended durably and in order.
//
// **Why a hash chain rather than a signature per event.** A run emits thousands
// of these; DSSE-signing each one would price honest recording out of the hot
// path, and an orchestrator that cannot afford to record is an orchestrator that
// does not record. Instead each event commits to its predecessor, so the chain
// head is a single value standing for the entire sequence — and the checkpoint
// and run attestations, which *are* signed, carry that head. Tampering with any
// event, in any position, breaks every hash after it and fails verification
// against a signature that was cheap because it was only taken once.
//
// **Why the typed columns.** `payload` stays opaque — ADP never parses it, same
// rule as `checkpoints.state`. But eval-based optimization means asking "what
// did the runs that scored well do differently", which is aggregation over
// tokens, cost, latency, tool identity, and outcome across millions of rows;
// answering that by unpacking jsonb per row is how this table becomes too slow
// to be used. The typed columns are a projection, not a second source of truth,
// and they are covered by `hash` exactly like the payload is — so a projection
// that disagrees with its own chain is detectable rather than merely unlikely.
export const sessionEvents = pgTable(
  "session_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => sessions.id),
    seq: integer("seq").notNull(),
    // The vocabulary ADP does fix, because comparing trajectories across
    // harnesses is the whole point — a Claude Code tool call and an OpenHands
    // tool call have to land in the same bucket or cross-harness analysis is
    // string matching on someone's private event names. `custom` is the escape
    // hatch that keeps the vocabulary from having to be complete.
    kind: text("kind", {
      enum: ["message", "model_call", "tool_call", "handoff", "commit", "test_result", "custom"],
    }).notNull(),
    // The harness's own name for the event within that kind (a tool name, a
    // message role, an orchestrator event id). Free-form; never branched on.
    type: text("type").notNull().default(""),
    // Defaulted, not merely non-null: the events endpoint declares
    // `required: [kind]`, so an event with only a kind is a legal request and
    // must not become a 500 the recorder cannot classify or retry. `{}` is what
    // a payload-less event means. See issue #63.
    payload: jsonb("payload").notNull().default({}),
    // Outcome, for the kinds that have one (tool_call, test_result, model_call).
    // Null where the notion doesn't apply — a `message` neither succeeds nor fails.
    status: text("status", { enum: ["success", "failure", "error", "rejected", "skipped"] }),
    model: text("model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    // Micro-USD as an integer: money in floating point accumulates error over a
    // million-event corpus, and the sums here are meant to be compared.
    costMicroUsd: integer("cost_micro_usd"),
    durationMs: integer("duration_ms"),
    // Set on `commit` events. Joins a trajectory to the changes it produced
    // without anyone parsing the payload to find out.
    gitSha: text("git_sha"),
    // Set on `handoff` events: this event on session A naming session B *is* the
    // edge A→B. A typed column rather than a payload convention, so the handoff
    // graph is a query instead of a scan.
    relatedSessionId: uuid("related_session_id"),
    // The orchestrator's own id for this event. A batching emitter retries, and
    // a retry must not append the trajectory twice — appendEvents drops ids this
    // session already has *before* chaining, so retry is idempotent rather than
    // merely usually-harmless.
    clientEventId: text("client_event_id"),
    // The emitter's own contiguous counter for this session, and who was
    // counting. `client_event_id` makes a retry harmless but cannot prove
    // nothing was *dropped*: an event that never arrived has no id to
    // deduplicate. A counter the emitter assigns at enqueue does prove it —
    // ADP rejects a batch that skips a number, so "the recorder recorded
    // everything" becomes checkable rather than asserted.
    //
    // Nullable because emitters that do not count are still allowed to append;
    // a session with no producer seqs is untracked, which is a different thing
    // from incomplete.
    producerSeq: bigint("producer_seq", { mode: "number" }),
    producerId: text("producer_id"),
    // When it happened, per the orchestrator, versus when ADP received it. Both,
    // because clock skew is real and neither answers the other's question.
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    hash: text("hash").notNull(),
    prevHash: text("prev_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("session_events_session_id_seq_idx").on(table.sessionId, table.seq),
    uniqueIndex("session_events_session_id_client_event_id_idx")
      .on(table.sessionId, table.clientEventId)
      .where(sql`${table.clientEventId} is not null`),
    // One writer per session is what keeps the chain serializable, so a
    // producer_seq is unique within the session — a second emitter counting
    // from 1 into the same chain is a bug, not a merge.
    uniqueIndex("session_events_session_id_producer_seq_idx")
      .on(table.sessionId, table.producerSeq)
      .where(sql`${table.producerSeq} is not null`),
    // Merging N sessions into one run-ordered trajectory reads each session's
    // events in time order.
    index("session_events_session_id_occurred_at_idx").on(table.sessionId, table.occurredAt),
    index("session_events_session_id_kind_idx").on(table.sessionId, table.kind),
  ],
);

// A deterministic evaluation of a run, attached to the commit the run produced.
//
// The evidence *is* `gate_results.envelope` — recording an eval writes an
// ordinary gate result (core/evals.ts), so land policy, `gh pr checks`, the
// evidence bundle, and candidate-set `best_score` all consume it through paths
// that already exist. This table is the run-scoped projection of that, plus the
// two fields that make "deterministic" a checkable claim rather than an
// adjective: `specDigest` names exactly which eval definition ran, and
// `trajectoryDigest` names the trajectory it was scored against.
export const evals = pgTable(
  "evals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id").notNull().references(() => repos.id),
    runId: uuid("run_id").notNull().references(() => runs.id),
    name: text("name").notNull(),
    gitSha: text("git_sha").notNull(),
    specDigest: text("spec_digest").notNull(),
    // Nullable because a pass/fail eval is a legitimate eval. `best_score`
    // simply cannot rank one, which is the honest outcome (core/candidate-sets.ts
    // deliberately treats an unscored candidate as unmeasured, not as zero).
    // A projection for ordering; the exact value as scored lives in the signed
    // predicate, which is what anyone re-verifying the eval reads.
    score: doublePrecision("score"),
    passed: boolean("passed").notNull(),
    // The gate result this eval was reported as. The FK is the statement that
    // there is one evidence path, not two.
    gateResultId: uuid("gate_result_id").notNull().references(() => gateResults.id),
    trajectoryDigest: text("trajectory_digest"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("evals_run_id_idx").on(table.runId),
    index("evals_repo_id_name_idx").on(table.repoId, table.name),
  ],
);

// A signed, ordered point a session can be resumed from. `envelope` is the
// same DSSE-wrapped in-toto Statement shape `gate_results.envelope` uses and
// plays the same role: the evidence *is* the envelope, the other columns are a
// queryable projection of it rather than a second source of truth.
//
// Two rules on `state` hold from the first commit. It is **opaque** — ADP never
// parses it or branches on it, so a harness storing its own format needs no ADP
// change. And it is **covered by the signature**: the statement binds `git_sha`
// together with a hash of `state`, so a resume under a different harness can
// verify it received what was written rather than trusting the transport.
export const checkpoints = pgTable(
  "checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => sessions.id),
    seq: integer("seq").notNull(),
    gitSha: text("git_sha").notNull(),
    harness: text("harness").notNull(),
    state: jsonb("state").notNull(),
    envelope: jsonb("envelope").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("checkpoints_session_id_seq_idx").on(table.sessionId, table.seq)],
);

// Outbound webhook subscriptions, GitHub-shaped (docs/pragmatic_mvp.md M2:
// "outbound webhook emitter"). The decrypted secret signs deliveries
// (HMAC-SHA256, GitHub's own `X-Hub-Signature-256` header shape,
// core/webhooks.ts) — never returned in a serialized response, same as
// GitHub's own hooks API. Distinct from a mirror's own
// `webhookSecretCiphertext` below, which verifies *inbound* deliveries from
// GitHub rather than signing outbound ones.
export const webhooks = pgTable("webhooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: uuid("repo_id").notNull().references(() => repos.id),
  targetUrl: text("target_url").notNull(),
  // AES-256-GCM at rest (core/mirror-crypto.ts, keyed by MIRROR_CREDENTIAL_KEY)
  // — the plaintext secret signs outbound deliveries (core/webhooks.ts) and
  // is never stored raw, same bar as mirrors.credentialCiphertext below.
  secretCiphertext: text("secret_ciphertext").notNull(),
  events: text("events").array().notNull().default([]),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// M2 mirror mode: per-repo config for bidirectional sync with a real GitHub
// repo. One row per repo (v0) — both `credentialCiphertext` (never the raw
// PAT) and `webhookSecretCiphertext` (verifies inbound `X-Hub-Signature-256`
// from GitHub) are AES-256-GCM encrypted (core/mirror-crypto.ts).
// `lastOutboundSha` / `lastInboundSha` track the defaultBranch tip last
// synced in each direction — v0 tracks a single branch, not every ref.
export const mirrors = pgTable(
  "mirrors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id").notNull().references(() => repos.id),
    direction: text("direction", { enum: ["outbound", "inbound", "both"] }).notNull(),
    remoteUrl: text("remote_url").notNull(),
    credentialCiphertext: text("credential_ciphertext").notNull(),
    // AES-256-GCM at rest, same key/mechanism as credentialCiphertext —
    // verifies inbound `X-Hub-Signature-256` from GitHub (http-rest/mirror-webhook.ts).
    webhookSecretCiphertext: text("webhook_secret_ciphertext").notNull(),
    // Auto-record actor for inbound commits (operations.actorId is a hard
    // FK) — a system identity created alongside an inbound-capable mirror,
    // principal "mirror:github:<owner>/<name>". Null for outbound-only.
    identityId: uuid("identity_id").references(() => identities.id),
    enabled: boolean("enabled").notNull().default(true),
    lastOutboundSha: text("last_outbound_sha"),
    lastInboundSha: text("last_inbound_sha"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.repoId)],
);

// Outbox for outbound pushes (populated inside post-receive's transaction,
// drained by core/mirror-poller.ts) and audit trail for both directions
// (inbound rows are written synchronously, already resolved).
export const mirrorSyncLog = pgTable("mirror_sync_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  mirrorId: uuid("mirror_id").notNull().references(() => mirrors.id),
  direction: text("direction", { enum: ["outbound", "inbound"] }).notNull(),
  ref: text("ref").notNull(),
  sha: text("sha").notNull(),
  status: text("status", { enum: ["pending", "in_progress", "success", "failed"] }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Append-only spine: every mutation writes its state change and its operations
// row in a single transaction. This *is* the op log and the audit log.
// `repoId` is nullable because a handful of verbs are genuinely global (none
// exist yet, but the op log predates any repo-scoped requirement — see the
// migration note); every call site that has a repo passes it.
export const operations = pgTable(
  "operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id").references(() => repos.id),
    actorId: uuid("actor_id").notNull().references(() => identities.id),
    verb: text("verb").notNull(),
    target: text("target").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    parentOp: uuid("parent_op"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Replaces the `target` LIKE-prefix scan http-rest/operations.ts's
  // repoTargetFilter used to do (docs/m2-readiness-review.md) — every op in
  // this table is repo-scoped in practice, this just makes that queryable.
  (table) => [index("operations_repo_id_idx").on(table.repoId)],
);

// M4-9a (docs/m4-readiness-review.md §4): the gate runner's job queue —
// "Postgres job queue" in pragmatic_mvp.md's own layout table, not a new
// message broker. This table is the *contract* between the API process and
// a runner process that, per pragmatic_mvp.md §4.5/§4.7, must be able to run
// on a separate, untrusted-code host with no database credentials of its
// own: a runner claims and completes jobs over the REST routes in
// http-rest/gate-jobs.ts, the same way `cli/` talks to this server, never by
// importing this schema or holding a DATABASE_URL. `image`/`command` are
// resolved by whatever enqueues a job (M4-9c reads them from adp.yaml); this
// table doesn't know or care where they came from.
export const gateJobs = pgTable(
  "gate_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id").notNull().references(() => repos.id),
    gitSha: text("git_sha").notNull(),
    // The gate name a completed job reports under — matches gate_results.name
    // (core/gates.ts) once M4-9c wires completion through to a real gate report.
    name: text("name").notNull(),
    image: text("image").notNull(),
    command: text("command").notNull(),
    timeoutMs: integer("timeout_ms").notNull(),
    status: text("status", {
      enum: ["queued", "running", "succeeded", "failed", "timed_out", "error"],
    })
      .notNull()
      .default("queued"),
    actorId: uuid("actor_id").notNull().references(() => identities.id),
    // Opaque, like sessions.harness — a free-form identifier the claiming
    // runner supplies (hostname, pid, whatever it wants), never branched on.
    // Null until claimed.
    claimedBy: text("claimed_by"),
    // The *authenticated* identity that claimed the job — the ownership check
    // http-rest/gate-jobs.ts's checkout/complete enforce (#88). claimedBy
    // above can't serve that purpose: it's client-supplied, so any runner
    // token could send another runner's string. Null until claimed; a
    // `running` row with this still null (claimed before the column existed)
    // fails the ownership check closed rather than open.
    claimedByIdentityId: uuid("claimed_by_identity_id").references(() => identities.id),
    exitCode: integer("exit_code"),
    // Inline, bounded (truncated by http-rest/gate-jobs.ts's complete
    // handler) rather than a pointer into an object store — there isn't one
    // yet (M4-8). Revisit the bound once real job output sizes are known.
    logs: text("logs"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    // The claim query: oldest queued job first, instance-wide (a runner
    // serves the whole instance, not one repo — see http-rest/gate-jobs.ts).
    index("gate_jobs_status_created_at_idx").on(table.status, table.createdAt),
    index("gate_jobs_repo_id_git_sha_name_idx").on(table.repoId, table.gitSha, table.name),
  ],
);
