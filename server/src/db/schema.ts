import { pgTable, text, timestamp, uuid, jsonb, boolean, integer, unique, index } from "drizzle-orm/pg-core";

export const repos = pgTable("repos", {
  id: uuid("id").primaryKey().defaultRandom(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  selectionPolicy: text("selection_policy").notNull().default("manual"),
  selectedProposalId: uuid("selected_proposal_id"),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Every land-policy check (core/gate-results-lookup.ts) and evidence-bundle
  // read filters on (repo_id, git_sha), then narrows to `name` when resolving
  // a specific gate's latest verdict — same reasoning as `changes`' index.
  (table) => [index("gate_results_repo_id_git_sha_name_idx").on(table.repoId, table.gitSha, table.name)],
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

// M2 mirror mode: per-repo config for bidirectional sync with a real GitHub
// repo. One row per repo (v0) — `credentialCiphertext` is AES-256-GCM
// encrypted (core/mirror-crypto.ts), never the raw PAT; `webhookSecret`
// verifies inbound `X-Hub-Signature-256` from GitHub. `lastOutboundSha` /
// `lastInboundSha` track the defaultBranch tip last synced in each
// direction — v0 tracks a single branch, not every ref.
export const mirrors = pgTable(
  "mirrors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id").notNull().references(() => repos.id),
    direction: text("direction", { enum: ["outbound", "inbound", "both"] }).notNull(),
    remoteUrl: text("remote_url").notNull(),
    credentialCiphertext: text("credential_ciphertext").notNull(),
    webhookSecret: text("webhook_secret").notNull(),
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
