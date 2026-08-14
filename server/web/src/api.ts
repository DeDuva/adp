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

export interface EvidenceBundle {
  git_sha: string;
  change: { id: string; intent_id: string | null; provenance: unknown; signature: string; created_at: string } | null;
  gates: { name: string; status: string; summary: string; envelope: unknown; created_at: string }[];
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
