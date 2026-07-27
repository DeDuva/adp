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

  getEvidence: (conn: Connection, gitSha: string) =>
    request<EvidenceBundle>(conn, `/api/adp/repos/${conn.owner}/${conn.repo}/evidence/${gitSha}`),

  whoami: (conn: Connection) => request<{ login: string }>(conn, "/api/v3/user"),
};
