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
import { desc, sql } from "drizzle-orm";

// M4-0: the tenancy boundary every other M4
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
  // reviewable changes" true for free: landing
  // a policy change already goes through the same intent→diff→evidence→
  // provenance path as any other change, because it *is* one. Null means
  // the org has designated no policy repo yet — an empty floor, not an error.
  policyRepoId: uuid("policy_repo_id").references((): AnyPgColumn => repos.id),
  // The blast radius refuses every
  // land attempt for every repo in this org while set (core/land-policy.ts).
  // Deliberately does NOT block opening a new proposal — that's a stated,
  // narrower scope for this slice (see the M4-2 PR description); a proposal
  // sitting open-but-unlandable while the switch is active is a safe
  // intermediate state, landing is the consequential action.
  killSwitch: boolean("kill_switch").notNull().default(false),
  // M4-3: null means unlimited — the default for every org until an operator
  // sets one, same "absence is not a limit" convention `workspaces.expiresAt`
  // already uses.
  maxRepos: integer("max_repos"),
  maxConcurrentWorkspaces: integer("max_concurrent_workspaces"),
  // M4-9d: same "null is unlimited" convention as the two quotas above,
  // checked against gate_jobs.status = 'running' across every repo in the
  // org (http-rest/gate-jobs.ts's claim route) rather than at enqueue time —
  // an org's queue can grow arbitrarily deep, this bounds how much of it
  // executes at once, which is what actually costs CPU/memory on the runner
  // fleet.
  maxConcurrentGateJobs: integer("max_concurrent_gate_jobs"),
  // M4-3, the half that was never built. This column waited on M4-8's object
  // store "to meter against" while M4-8's own sizing waited on this quota's
  // shape existing to bound it (vs its M4-8
  // paragraph) — a deadlock that held for the whole milestone while nothing
  // bounded how much one org could write. It is broken here by refusing to
  // wait: the meter counts the bytes that exist *today* — Postgres rows and
  // on-disk git — and gains the CAS as a third term when there is one. The
  // shape (a byte ceiling per org, null = unlimited) is what M4-8 needs, and
  // it does not change when the thing being counted grows a fourth source.
  //
  // bigint, not integer: 2 GiB is a plausible ceiling for one org and would
  // overflow int4 as a *byte* count.
  maxStorageBytes: bigint("max_storage_bytes", { mode: "number" }),
  // #161: how long this org keeps trajectory payloads, in days. Null means
  // "use the instance default" — absence defers upward, like the land-policy
  // floors and unlike M4-3's quotas above, where null means unlimited. Keeping
  // payloads forever is spelled `0`, explicitly, so that it is a choice
  // somebody made rather than a column nobody filled in.
  trajectoryRetentionDays: integer("trajectory_retention_days"),
  // The meter's last reading, not a running total. Storage is measured on a
  // tick (core/storage-usage.ts) and enforcement reads this column, because
  // the alternative — counting bytes synchronously on every append — would
  // put a full scan of session_events in the trajectory hot path. The cost of
  // that choice is stated rather than hidden: an org can overshoot its ceiling
  // by at most one measurement interval's worth of writes, and
  // `storageMeasuredAt` is served alongside `used` so an operator can see how
  // stale the number they are looking at is. Null means never measured, which
  // is not zero: enforcement treats an unmeasured org as under quota, since
  // refusing writes on the basis of a measurement that has not happened would
  // fail closed on a cold start of every instance.
  storageBytesUsed: bigint("storage_bytes_used", { mode: "number" }),
  storageMeasuredAt: timestamp("storage_measured_at", { withTimezone: true }),
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

// M4-5: an identity as some external issuer knows it. The readiness review
// left the shape open — "a new `kind`, or a linked external-identity table" —
// and this is the linked table, for one reason that decides it: Google's `sub`
// is the stable identifier and the email is not. A person who changes their
// email address is the same person, and a `principal` keyed on email would
// either lock them out or, far worse, hand their account to whoever the
// address gets reassigned to. So the link is keyed on (issuer, subject) and
// `email` is carried alongside for display only, refreshed on each login and
// never used to find the row.
//
// It also keeps `identities` unchanged: an identity is still a principal with
// a kind, and how a human proved they are that principal is a separate fact
// that can grow a second row later (a second provider) without touching it.
export const externalIdentities = pgTable(
  "external_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The OIDC issuer, exactly as it appears in the verified `iss` claim.
    // Part of the key rather than assumed constant: `sub` is only unique
    // within an issuer, so a single-provider deployment that later adds a
    // second must not be able to collide two people onto one identity.
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    identityId: uuid("identity_id").notNull().references(() => identities.id),
    // Display only. See the note above — never a lookup key.
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (table) => [unique().on(table.issuer, table.subject)],
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

export const intents = pgTable(
  "intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id").notNull().references(() => repos.id),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    source: text("source", { enum: ["issue", "task", "api"] }).notNull(),
    parentId: uuid("parent_id"),
    // #226: which issue, on whose host.
    //
    // `source` already said an intent came from an issue, and that was as far
    // as it went — so a team organising its work in GitHub Issues got an ADP
    // intent universe *beside* theirs rather than under it, with no way to ask
    // "is this the same piece of work as that one?" other than comparing
    // titles.
    //
    // The host is a column rather than something parsed out of the URL because
    // it is the identity half. An intent is the object 5-16 has to carry to
    // another instance intact, and "issue 92" means nothing without saying
    // whose 92 — where the URL is a display string that can be rewritten by a
    // proxy, an enterprise hostname change, or a repository transfer.
    upstreamHost: text("upstream_host"),
    upstreamNumber: integer("upstream_number"),
    upstreamUrl: text("upstream_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One intent per upstream issue, and partial for the same reason the
    // proposals index is (#224): it says something about ingested rows only.
    uniqueIndex("intents_repo_upstream_idx")
      .on(table.repoId, table.upstreamHost, table.upstreamNumber)
      .where(sql`${table.upstreamNumber} is not null`),
  ],
);

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
  //
  // #143: unique, not merely indexed. Two write paths record a change for the
  // same commit — the push hook, and the explicit POST that binds an intent —
  // and while it was only an index, the documented push-then-bind sequence
  // left two rows for one sha, one bound and one not. The evidence read chose
  // between them with no ORDER BY. A signed record of a commit is a fact about
  // that commit, so there is exactly one of it, and the database is where that
  // is said rather than in the four call sites that must not violate it.
  (table) => [uniqueIndex("changes_repo_id_git_sha_idx").on(table.repoId, table.gitSha)],
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
    // #224: the upstream pull request this proposal shadows, when it shadows
    // one. Both null on a natively-created proposal, and that nullness is the
    // only thing distinguishing the two kinds — deliberately, because every
    // capability companion mode wants back (evaluateLandPolicy, undo, the
    // check runs) already takes a proposal, and a parallel "external pull
    // request" type would mean reimplementing each of them against a second
    // shape.
    //
    // `upstreamNumber` is recorded even though `number` is currently equal to
    // it. The two are equal by *decision* — 5a's numbering question, settled
    // as "adopt the upstream number so `gh pr view 482` means one thing on
    // both planes" — and a decision is exactly the kind of thing that gets
    // revisited. A reader asking "which GitHub pull request is this?" must not
    // have to know that answer, and a query for "every ingested proposal"
    // must not be a query for "every proposal whose number happens to match
    // something upstream".
    upstreamNumber: integer("upstream_number"),
    upstreamUrl: text("upstream_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
  },
  (table) => [
    unique().on(table.repoId, table.number),
    // Partial, because it says something only about ingested rows: one
    // shadow proposal per upstream pull request. GitHub redelivers webhooks
    // routinely, so this is the same reasoning as gate_results' partial
    // unique on (repo_id, external_id) — idempotency belongs in the database
    // rather than in a read-then-write every delivery has to get right.
    uniqueIndex("proposals_repo_upstream_number_idx")
      .on(table.repoId, table.upstreamNumber)
      .where(sql`${table.upstreamNumber} is not null`),
  ],
);

// Native-plane-only concept ("the only MVP
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

export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id").notNull().references(() => proposals.id),
    reviewerId: uuid("reviewer_id").notNull().references(() => identities.id),
    state: text("state", { enum: ["approved", "changes_requested", "commented"] }).notNull(),
    body: text("body").notNull().default(""),
    annotations: jsonb("annotations"),
    // #227: the upstream review's own id, when this row shadows one. Null on a
    // review submitted here. GitHub redelivers, and a review has no natural
    // key — two approvals from one person on one proposal is an ordinary
    // sequence, not a duplicate — so without this there is nothing to dedup on.
    upstreamId: text("upstream_id"),
    // #227: GitHub can dismiss a review, and a dismissed approval must stop
    // counting toward `one_approval`. Recorded rather than deleted: the review
    // happened, and an approval that was withdrawn is a different fact from one
    // that was never given.
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("reviews_proposal_upstream_id_idx")
      .on(table.proposalId, table.upstreamId)
      .where(sql`${table.upstreamId} is not null`),
  ],
);

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

// Native-plane-only concept ("Workspace | A
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

// M3 (M3-1): a unit of agent work that
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
    // #148: what the secret detector replaced in this event's payload, as
    // `[{ path, pattern }]`. Null when nothing fired, which is the ordinary
    // case and the reason it is null rather than an empty array — see
    // core/trajectory.ts's eventHash for why an unset field must stay *absent*
    // rather than become an explicit empty value.
    //
    // Recorded separately from the inline `[redacted:…]` marker on purpose: a
    // reader should see that an event was redacted without having to notice it
    // in the text, and a query for "which sessions hit the detector" should not
    // be a full-text search over every payload in the corpus.
    redactions: jsonb("redactions"),
    // #199: sha256 of the canonical JSON of the payload **as supplied**, set
    // when `payload` above is a structural projection rather than that payload
    // — which is the default (`trajectory.payloads: structure` in `adp.yaml`).
    // Null means the payload is stored exactly as it arrived, so this column
    // is both the commitment and the answer to "is this verbatim".
    //
    // It is the commitment half of "verified, payload not retained": ADP no
    // longer holds the string content, and a producer holding its own copy can
    // still prove the record corresponds to it. Nullable and left null on the
    // `full` path for the same chain reason `redactions` is — `eventHash`
    // includes the key only when set, so a `full`-mode event and every row
    // written before this column existed hash to what they always did.
    payloadDigest: text("payload_digest"),
    // #161: whether ADP still holds this event's payload, or aged it out under
    // the org's retention window. **Not covered by `eventHash`, and it cannot
    // be** — every row written before this column existed would change what it
    // hashes to, and `verifyChain` would report the whole corpus as tampered.
    // The same reasoning `producerSeq`, `redactions` and `payloadDigest` are
    // written down under: this is a fact about what ADP still *holds*, and the
    // chain commits to what the producer *sent*.
    //
    // False costs something precise and worth stating: with the payload gone,
    // that event's hash can no longer be re-derived from its contents, so its
    // typed columns are no longer independently verifiable either. What still
    // holds is the link — its stored hash is what the next event chains to —
    // and any signed checkpoint head past it still pins the whole prefix, which
    // is what keeps a wholesale rewrite detectable. See core/trajectory.ts.
    payloadRetained: boolean("payload_retained").notNull().default(true),
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

// Outbound webhook subscriptions, GitHub-shaped (
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
    // #228: the inbound poller's cursor. Null until the first poll, which is
    // what makes that poll a backfill of everything currently open rather than
    // a window nobody chose.
    //
    // It is a poll *time* rather than a per-object cursor because that is what
    // GitHub's own filters take (`since` on issues, `sort=updated` on pulls),
    // and because a single timestamp is the only cursor that stays correct when
    // the poller is behind: falling further behind widens the window instead of
    // skipping what happened while it was down.
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.repoId)],
);

// #232: the GitHub App this instance created for itself, and where it is
// installed.
//
// A row here is credentials, not configuration. Setting up companion mode used
// to cost a personal access token and a webhook created by hand in GitHub's
// settings — three manual steps and one secret before anything worked, and a
// PAT is the wrong credential shape regardless: it carries the developer's
// whole account scope, it expires on their schedule rather than the
// installation's, and revoking it breaks unrelated things.
//
// **The manifest flow matters more than the App.** GitHub creates the App in
// the user's own organisation and hands the credentials back to the instance
// that served the manifest, so a self-hosted ADP gets one-click installation
// with no hosted control plane in the middle — which is what keeps this
// unblocked by the budget decision that defers hosted preview.
//
// One app per instance rather than per org. The App is *this deployment's*
// identity to GitHub; an org here is a tenant inside it, and giving each tenant
// its own App would mean each of them running the manifest flow, which is the
// manual setup this replaces.
export const githubApps = pgTable("github_apps", {
  id: uuid("id").primaryKey().defaultRandom(),
  // GitHub's numeric app id, which is what the JWT's `iss` claim carries.
  appId: text("app_id").notNull().unique(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  htmlUrl: text("html_url").notNull(),
  clientId: text("client_id").notNull(),
  // All three encrypted with the same key and mechanism as mirror credentials
  // (core/mirror-crypto.ts). The private key in particular is the App: anyone
  // holding it can mint an installation token for every repository the App is
  // installed on.
  clientSecretCiphertext: text("client_secret_ciphertext").notNull(),
  privateKeyCiphertext: text("private_key_ciphertext").notNull(),
  webhookSecretCiphertext: text("webhook_secret_ciphertext").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const githubAppInstallations = pgTable(
  "github_app_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id").notNull().references(() => githubApps.id),
    installationId: text("installation_id").notNull(),
    // The GitHub account the App is installed on — an org or a user.
    account: text("account").notNull(),
    // Set when the App is uninstalled. The row is kept rather than deleted:
    // "uninstalling is clean" means ADP stops receiving events, not that the
    // record of what was ingested while it was installed disappears — every
    // change, proposal and gate result it produced still points at it.
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.appId, table.installationId)],
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
    // #97: the org an org-LEVEL operation belongs to (org.kill_switch,
    // org.create, org.quota_update, an org-scoped token.mint). Repo-scoped
    // ops leave it null — their org is reachable through the repo — but an
    // op with repoId null and orgId null is invisible to the org audit-log
    // export, which is exactly what happened to the kill switch.
    // #97: the org an org-LEVEL operation belongs to (org.kill_switch,
    // org.create, org.quota_update, an org-scoped token.mint). Repo-scoped
    // ops leave it null — their org is reachable through the repo — but an
    // op with repoId null and orgId null is invisible to the org audit-log
    // export, which is exactly what happened to the kill switch.
    //
    // #147 tried widening this to "the org of *every* operation", so the
    // export could ask one indexed question instead of an un-indexable OR.
    // It works and it was reverted: the column carries a foreign key, so
    // filling it on every row makes every operation insert take a
    // `FOR KEY SHARE` lock on the org — one row per tenant, on the write path
    // of every push, merge and gate result. Against `repos`, whose FK is
    // locked by the same insert, that is a lock-order inversion:
    // `e2e-candidate-fanout`'s 50-way fan-out deadlocked on it immediately.
    // The export gets its index a different way, with no schema change at
    // all — see http-rest/audit-log.ts.
    orgId: uuid("org_id").references(() => orgs.id),
    actorId: uuid("actor_id").notNull().references(() => identities.id),
    verb: text("verb").notNull(),
    target: text("target").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    parentOp: uuid("parent_op"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // #147: the leading column is the always-present predicate and the rest is
  // the sort key, so each reader's filter *and* its ORDER BY are one ordered
  // index walk that stops at LIMIT. Both readers previously planned a Sort
  // over the whole matching slice; see 0031's migration for the numbers.
  //
  // Deliberately two indexes and not four. A third on (repo_id, verb, …)
  // measured 2.2 ms -> 0.2 ms on the selective-verb history query, which is a
  // real improvement over an already-acceptable number, bought with permanent
  // write amplification on a table written inside the transaction of every
  // change in the system. Revisit with the ingest numbers 3-5 (#195) produces,
  // not on principle.
  (table) => [
    index("operations_repo_id_created_at_idx").on(table.repoId, desc(table.createdAt), desc(table.id)),
    index("operations_org_id_created_at_idx").on(table.orgId, desc(table.createdAt), desc(table.id)),
  ],
);

// M4-9a: the gate runner's job queue —
// a "Postgres job queue" by design, not a new
// message broker. This table is the *contract* between the API process and
// a runner process that,, must be able to run
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
    // #92: the claim is a LEASE, not a permanent grant. Set at claim time to
    // now + timeout_ms + a fixed grace; the reaper (core/gate-job-reaper.ts)
    // requeues a `running` job whose lease has expired — a runner that died
    // used to leave the job `running` forever, blocking that commit's land
    // and holding an org concurrency slot with no recovery short of psql.
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    // How many times this job has been claimed. Bounded by the reaper's
    // retry cap: a job that keeps expiring stops being requeued and is
    // marked `error` instead of looping forever.
    attempts: integer("attempts").notNull().default(0),
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
