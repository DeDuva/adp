// Relative paths only — /api works whether this is served by the same
// Fastify instance (production, /ui/*) or proxied by Vite's dev server to a
// local backend (vite.config.ts). No CORS story needed either way.
export interface Connection {
  token: string;
  owner: string;
  repo: string;
}

const STORAGE_KEY = "adp-web.connection";

export function loadConnection(): Connection | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Connection;
  } catch {
    return null;
  }
}

export function saveConnection(conn: Connection): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(conn));
}

export function clearConnection(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(conn: Connection, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${conn.token}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "message" in body ? String((body as { message: unknown }).message) : text;
    throw new ApiError(res.status, message || `${res.status} ${res.statusText}`);
  }
  return body as T;
}

export interface Issue {
  id: string;
  number: number;
  // #157: the intent an issue carries, which is what the runs against it are
  // keyed by. Present on the server since M1 and unused here until the UI had
  // runs to point at.
  intent_id: string | null;
  title: string;
  body: string;
  state: "open" | "closed";
  user: { login: string };
  created_at: string;
  closed_at: string | null;
}

export interface IssueComment {
  id: string;
  body: string;
  created_at: string;
}

export interface Proposal {
  id: string;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  head: { ref: string; sha: string };
  base: { ref: string };
  change_id: string | null;
  created_at: string;
  closed_at: string | null;
  merged_at: string | null;
}

export interface Review {
  id: string;
  state: "approved" | "changes_requested" | "commented";
  body: string;
  created_at: string;
}

export interface FileChange {
  filename: string;
  status: string;
}

export interface Operation {
  id: string;
  actor_id: string;
  verb: string;
  target: string;
  before: unknown;
  after: unknown;
  parent_op: string | null;
  created_at: string;
}

export interface GateResult {
  id: string;
  git_sha: string;
  name: string;
  status: "success" | "failure" | "pending";
  summary: string;
  created_at: string;
}

// M3 / D1: N proposals fanned out against one intent, one landed, the rest
// reclaimed but still queryable. The comparison view is the "money shot" the
// prototype doc's D1 exits on.
export interface CandidateSetSummary {
  id: string;
  intent_id: string;
  selection_policy: "manual" | "first_green" | "best_score";
  selected_proposal_id: string | null;
  status: "open" | "resolved" | "abandoned";
  resolved_at: string | null;
  created_at: string;
  candidate_count: number;
}

export interface Candidate {
  id: string;
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  head_ref: string;
  head_sha: string;
  // null means "not measured", not zero — a candidate with no score gate was
  // never ranked, which is a different thing from ranking badly.
  score: number | null;
  gates: { name: string; status: "success" | "failure" | "pending"; summary: string }[];
}

export interface CandidateSetDetail extends Omit<CandidateSetSummary, "candidate_count"> {
  candidates: Candidate[];
}

// M4-7 — the org policy console.
//
// A runtime array, not just a type (#98): this is a hand-copy of the
// server's LandRequirement enum (server/src/core/repo-policy.ts), and the
// copy had already drifted once — `gates_confident` was missing, so the
// console rendered that requirement as a blank label precisely on the
// malformed-policy fail-closed path it has a dedicated red banner for. The
// array is what api.test.ts binds to the server's z.enum, both directions;
// the type is derived so it can never disagree with the array.
export const LAND_REQUIREMENTS = ["gates_green", "one_approval", "gates_confident"] as const;
export type LandRequirement = (typeof LAND_REQUIREMENTS)[number];
export type PolicyLayer = "instance" | "org" | "repo";

export interface OrgSummary {
  id: string;
  name: string;
  kill_switch: boolean;
}

export interface OrgQuota {
  // null is unlimited, not zero — the convention the org quota columns use.
  limit: number | null;
  used: number;
}

export interface OrgDetail extends OrgSummary {
  policy_repo: { owner: string; name: string; default_branch: string } | null;
  org_floor: {
    require: LandRequirement[];
    // "malformed" is the one worth rendering loudly: the floor shown is a
    // fail-closed default, not something anyone chose.
    source: "no_policy_repo" | "no_policy_file" | "ok" | "malformed";
  };
  instance_floor: LandRequirement[];
  quotas: {
    max_repos: OrgQuota;
    max_concurrent_workspaces: OrgQuota;
    max_concurrent_gate_jobs: OrgQuota;
  };
  // #161: how long this org keeps trajectory payloads, and what the next sweep
  // will reduce. `due_next` is what makes this a warning rather than a report —
  // an operator has to be told before it matters, not after.
  retention: {
    days: number;
    source: "org" | "instance";
    reduced: number;
    dueNext: number;
  };
}

export interface OrgRepoPolicy {
  id: string;
  owner: string;
  name: string;
  default_branch: string;
  is_policy_repo: boolean;
  repo_requirements: LandRequirement[];
  resolved: { requirement: LandRequirement; from: PolicyLayer[] }[];
}

// ── M3 surface: runs, sessions, trajectories, evals (#156) ────────────────
//
// The whole M3 plane was API-only until this: six views, none of them a run, a
// session, a trajectory, a checkpoint or an eval. A trajectory is worth its
// write cost only if something consumes it, and the second consumer has to be a
// person or the recording is an experiment rather than a product.

// A runtime array bound to the server's own list, the same way
// LAND_REQUIREMENTS is and for the same reason (#98): the kind filter is
// rendered from this, so a copy that drifts renders a filter that silently
// cannot select a kind the server writes.
export const EVENT_KINDS = [
  "message",
  "model_call",
  "tool_call",
  "handoff",
  "commit",
  "test_result",
  "custom",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const RUN_STATUSES = ["open", "closed", "abandoned"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface ComparisonEval {
  name: string;
  score: number | null;
  passed: boolean | null;
  gateStatus: string;
}

// One row of the runs list. This is `/runs/compare` without an intent filter —
// the aggregates the list wants (events, cost, duration, tool failures) are
// already computed there, server-side and in one request, which is the
// difference between a list and fifty round trips.
export interface RunRow {
  runId: string;
  externalRef: string | null;
  orchestrator: string;
  status: RunStatus;
  labels: Record<string, string>;
  finalGitSha: string | null;
  trajectoryDigest: string | null;
  eval: ComparisonEval | null;
  evals: (ComparisonEval & { createdAt: string })[];
  events: number;
  tokensIn: number;
  tokensOut: number;
  costMicroUsd: number;
  durationMs: number;
  toolCalls: number;
  toolFailures: number;
  createdAt: string;
  closedAt: string | null;
}

export interface RunSession {
  id: string;
  harness: string;
  status: "active" | "suspended" | "resumed" | "closed";
  workspace_id: string | null;
  resumed_from_session_id: string | null;
  event_count: number;
  chain_head: string | null;
  created_at: string;
}

export interface RunDetail {
  id: string;
  intent_id: string;
  orchestrator: string;
  external_ref: string | null;
  labels: Record<string, string>;
  status: RunStatus;
  final_git_sha: string | null;
  trajectory_digest: string | null;
  envelope: unknown;
  created_at: string;
  closed_at: string | null;
  sessions: RunSession[];
  evals: { id: string; name: string; score: number | null; passed: boolean | null; reporter_principal: string; separately_authorized: boolean; created_at: string }[];
  // #157: the commits this run produced, off `session_events.git_sha` on commit
  // events. The other direction of the edge the evidence bundle walks.
  commits: string[];
}

// Every typed column the chain commits to. They are rendered as what they are —
// tokens, cost, duration, tool identity, status — rather than as a JSON blob,
// which is the entire reason the schema has them.
export interface TrajectoryEvent {
  id: string;
  session_id: string;
  seq: number;
  kind: EventKind;
  type: string;
  payload: unknown;
  status: string | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_micro_usd: number | null;
  duration_ms: number | null;
  git_sha: string | null;
  related_session_id: string | null;
  client_event_id: string | null;
  producer_seq: number | null;
  producer_id: string | null;
  redactions: { path: string; pattern: string }[] | null;
  payload_digest: string | null;
  occurred_at: string;
  created_at: string;
}

export interface TrajectoryPage {
  run_id: string;
  total: number;
  events: TrajectoryEvent[];
}

// #152. `chains_ok` and `emitters_ok` are deliberately separate answers and the
// UI keeps them separate: "verified" and "nothing was dropped" are different
// assurances, and collapsing them into one green tick throws away the more
// interesting half. `coverage` and `prefix` say how much of each chain the
// answer is actually about.
export interface VerifySession {
  session_id: string;
  ok: boolean;
  event_count: number;
  head: string | null;
  broke_at_seq: number | null;
  reason: string | null;
  emitter_tracked: boolean;
  emitter_complete: boolean;
  emitter_first_gap: number | null;
  verified_from_seq: number;
  verified_to_seq: number;
  prefix: "recomputed" | "attested" | "assumed";
  attested_heads_checked: number;
  anchor: { checkpoint_id: string; checkpoint_seq: number; event_count: number; head: string } | null;
}

export interface RunVerification {
  run_id: string;
  ok: boolean;
  coverage: "full" | "from-checkpoint";
  chains_ok: boolean;
  emitters_ok: boolean;
  envelope_verified: boolean | null;
  trajectory_digest_matches: boolean | null;
  recomputed_trajectory_digest: string;
  attested_trajectory_digest: string | null;
  final_git_sha: string | null;
  attested_subject_sha: string | null;
  sessions: VerifySession[];
}

export interface Checkpoint {
  id: string;
  session_id: string;
  seq: number;
  git_sha: string;
  harness: string;
  state: unknown;
  envelope: unknown;
  created_at: string;
}

export interface SessionSummary {
  id: string;
  run_id: string | null;
  intent_id: string | null;
  workspace_id: string | null;
  harness: string;
  status: "active" | "suspended" | "resumed" | "closed";
  resumed_from_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionDetail extends SessionSummary {
  // Oldest first: the session that started the work, then each resume. A chain
  // across three harnesses is a picture rather than a series of API calls.
  lineage: SessionSummary[];
  checkpoints: Checkpoint[];
}

// #157: the edges out of a commit. Navigation rather than evidence — nothing
// here is signed — but it is the difference between holding the identifier of
// the thing you want and being able to follow it.
export interface ObservedModel {
  observed: string[];
  asserted: string | null;
  source: "observed" | "asserted" | "none";
}

export interface ProducedBy {
  models: ObservedModel;
  sessions: { id: string; harness: string; run_id: string | null; seq: number }[];
  runs: { id: string; orchestrator: string; labels: Record<string, string>; status: RunStatus }[];
  proposals: { number: number; title: string; state: "open" | "closed" | "merged" }[];
}

export interface EvidenceBundle {
  git_sha: string;
  change: {
    id: string;
    intent_id: string | null;
    intent: { id: string; title: string; issue_number: number | null } | null;
    provenance: unknown;
    signature: string;
    created_at: string;
  } | null;
  gates: { name: string; status: string; summary: string; envelope: unknown; created_at: string }[];
  produced_by: ProducedBy;
}

export const api = {
  listIssues: (conn: Connection) => request<Issue[]>(conn, `/api/v3/repos/${conn.owner}/${conn.repo}/issues`),
  getIssue: (conn: Connection, number: number) =>
    request<Issue>(conn, `/api/v3/repos/${conn.owner}/${conn.repo}/issues/${number}`),
  listIssueComments: (conn: Connection, number: number) =>
    request<IssueComment[]>(conn, `/api/v3/repos/${conn.owner}/${conn.repo}/issues/${number}/comments`),

  listProposals: (conn: Connection) => request<Proposal[]>(conn, `/api/v3/repos/${conn.owner}/${conn.repo}/pulls`),
  getProposal: (conn: Connection, number: number) =>
    request<Proposal>(conn, `/api/v3/repos/${conn.owner}/${conn.repo}/pulls/${number}`),
  listReviews: (conn: Connection, number: number) =>
    request<Review[]>(conn, `/api/v3/repos/${conn.owner}/${conn.repo}/pulls/${number}/reviews`),
  listFiles: (conn: Connection, number: number) =>
    request<FileChange[]>(conn, `/api/v3/repos/${conn.owner}/${conn.repo}/pulls/${number}/files`),
  getDiff: async (conn: Connection, number: number) => {
    const res = await fetch(`/api/v3/repos/${conn.owner}/${conn.repo}/pulls/${number}`, {
      headers: { Authorization: `Bearer ${conn.token}`, Accept: "application/vnd.github.diff" },
    });
    if (!res.ok) throw new ApiError(res.status, `Couldn't load diff (${res.status})`);
    return res.text();
  },
  listGatesForSha: (conn: Connection, sha: string) =>
    request<GateResult[]>(conn, `/api/v3/repos/${conn.owner}/${conn.repo}/commits/${sha}/gates`),

  listOperations: (conn: Connection, filters: Record<string, string | undefined>) => {
    const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]).toString();
    return request<Operation[]>(conn, `/api/adp/repos/${conn.owner}/${conn.repo}/operations${qs ? `?${qs}` : ""}`);
  },
  undoOperation: (conn: Connection, id: string) =>
    request<Operation>(conn, `/api/adp/repos/${conn.owner}/${conn.repo}/operations/${id}/undo`, {
      method: "POST",
      body: "{}",
    }),

  listCandidateSets: (conn: Connection) =>
    request<CandidateSetSummary[]>(conn, `/api/adp/repos/${conn.owner}/${conn.repo}/candidate-sets`),
  getCandidateSet: (conn: Connection, id: string) =>
    request<CandidateSetDetail>(conn, `/api/adp/repos/${conn.owner}/${conn.repo}/candidate-sets/${id}`),

  // #156. The list is `/runs/compare` with no intent filter — see RunRow.
  listRuns: (conn: Connection, filters: { intent_id?: string; status?: string }) => {
    const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]).toString();
    return request<{ intent_id: string | null; runs: RunRow[] }>(
      conn,
      `/api/adp/repos/${conn.owner}/${conn.repo}/runs/compare${qs ? `?${qs}` : ""}`,
    );
  },
  getRun: (conn: Connection, runId: string) =>
    request<RunDetail>(conn, `/api/adp/repos/${conn.owner}/${conn.repo}/runs/${runId}`),
  // Paged deliberately: a long trajectory must not load the run into the
  // browser, which is the same property #152 gave the server side of it.
  getTrajectory: (conn: Connection, runId: string, opts: { kinds?: EventKind[]; limit: number; offset: number }) => {
    const qs = new URLSearchParams({ limit: String(opts.limit), offset: String(opts.offset) });
    if (opts.kinds && opts.kinds.length > 0) qs.set("kinds", opts.kinds.join(","));
    return request<TrajectoryPage>(
      conn,
      `/api/adp/repos/${conn.owner}/${conn.repo}/runs/${runId}/trajectory?${qs.toString()}`,
    );
  },
  verifyRun: (conn: Connection, runId: string) =>
    request<RunVerification>(conn, `/api/adp/repos/${conn.owner}/${conn.repo}/runs/${runId}/verify`),
  getSession: (conn: Connection, sessionId: string) =>
    request<SessionDetail>(conn, `/api/adp/repos/${conn.owner}/${conn.repo}/sessions/${sessionId}`),
  verifySession: (conn: Connection, sessionId: string) =>
    request<VerifySession & { coverage: string }>(
      conn,
      `/api/adp/repos/${conn.owner}/${conn.repo}/sessions/${sessionId}/verify`,
    ),

  getEvidence: (conn: Connection, gitSha: string) =>
    request<EvidenceBundle>(conn, `/api/adp/repos/${conn.owner}/${conn.repo}/evidence/${gitSha}`),

  // M4-7. Org-scoped rather than repo-scoped, unlike everything above —
  // `listOrgs` returns [] for a token that is not scoped to an org, which is
  // what the console renders its "connect with an org-scoped token" state on.
  listOrgs: (conn: Connection) => request<OrgSummary[]>(conn, "/api/adp/orgs"),
  getOrg: (conn: Connection, orgId: string) => request<OrgDetail>(conn, `/api/adp/orgs/${orgId}`),
  listOrgRepos: (conn: Connection, orgId: string) =>
    request<OrgRepoPolicy[]>(conn, `/api/adp/orgs/${orgId}/repos`),
  setOrgKillSwitch: (conn: Connection, orgId: string, killSwitch: boolean) =>
    request<OrgSummary>(conn, `/api/adp/orgs/${orgId}`, {
      method: "PATCH",
      body: JSON.stringify({ kill_switch: killSwitch }),
    }),

  whoami: (conn: Connection) => request<{ login: string }>(conn, "/api/v3/user"),
};
