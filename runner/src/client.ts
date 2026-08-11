// A pure HTTP client of the queue mechanism server/src/http-rest/gate-jobs.ts
// exposes (M4-9a) — the only thing this process talks to. No import from
// server/ anywhere in this package, same convention cli/ and adapters/
// already follow, and here it is also the security boundary: this client
// carries a token scoped to nothing but "runner" (auth/plugin.ts), never
// repo:write, never a database credential.

export interface ClaimedGateJob {
  id: string;
  repo_id: string;
  git_sha: string;
  name: string;
  image: string;
  command: string;
  timeout_ms: number;
  status: string;
  claimed_by: string | null;
}

export interface CompleteResult {
  status: "succeeded" | "failed" | "timed_out" | "error";
  exitCode: number | null;
  logs: string;
}

export class GateJobClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" };
  }

  async claim(claimedBy: string): Promise<ClaimedGateJob | null> {
    const res = await fetch(new URL("/api/adp/gate-jobs/claim", this.baseUrl), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ claimed_by: claimedBy }),
    });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`claim failed: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as ClaimedGateJob;
  }

  async complete(jobId: string, result: CompleteResult): Promise<void> {
    const res = await fetch(new URL(`/api/adp/gate-jobs/${jobId}/complete`, this.baseUrl), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ status: result.status, exit_code: result.exitCode, logs: result.logs }),
    });
    if (!res.ok) throw new Error(`complete failed: HTTP ${res.status} ${await res.text()}`);
  }

  // M4-9c: a tar archive of the claimed job's own repo/sha — "materializes a
  // checkout" for docker.ts's `docker cp` step. Only Authorization, same as
  // every other call this client makes; no separate credential for git
  // content, and nothing here ever touches the ADP git remote directly.
  async checkout(jobId: string): Promise<Buffer> {
    const res = await fetch(new URL(`/api/adp/gate-jobs/${jobId}/checkout`, this.baseUrl), {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`checkout failed: HTTP ${res.status} ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
