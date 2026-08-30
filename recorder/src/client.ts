// A pure HTTP client of the trajectory routes in
// server/src/http-rest/sessions.ts. No `server/` import anywhere in this
// package — same convention `runner/`, `cli/` and `adapters/` follow.
//
// The outcomes are typed rather than thrown, because the shipper has to do
// something different for each one and `catch` is the wrong shape for a
// decision table. The distinction that matters most is between *retry* and
// *stop*: a network failure or a 5xx will succeed later and the events must be
// kept; a 422 will never succeed and retrying it forever is how a recorder
// turns a rejected batch into an infinite loop against someone's server.
import type { SpooledEvent } from "./events.js";

export interface AppendAccepted {
  outcome: "accepted";
  appended: number;
  duplicates: string[];
  count: number;
  head: string;
  /** The highest producer_seq the server has durably stored for this session. */
  acceptedThrough: number | null;
}

export interface AppendGap {
  outcome: "gap";
  /** Where the server wants the spool to replay from. */
  expectedNextSeq: number;
  message: string;
}

export interface AppendRefused {
  outcome: "refused";
  status: number;
  message: string;
}

export interface AppendUnavailable {
  outcome: "unavailable";
  status: number | null;
  message: string;
}

export type AppendOutcome = AppendAccepted | AppendGap | AppendRefused | AppendUnavailable;

export interface StartedSession {
  id: string;
  harness: string;
  intent_id: string | null;
  run_id: string | null;
  status: string;
}

export class TrajectoryClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" };
  }

  async startSession(
    owner: string,
    repo: string,
    body: { harness: string; intent_id?: string; run_id?: string; workspace_id?: string },
  ): Promise<StartedSession> {
    const res = await this.fetchImpl(new URL(`/api/adp/repos/${owner}/${repo}/sessions`, this.baseUrl), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`start session failed: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as StartedSession;
  }

  /**
   * Deliver a batch, in order, and classify what came back.
   *
   * The batch is sent whole — the endpoint is all-or-nothing by design, so a
   * partial success is not a state either side can be in.
   */
  async appendEvents(
    owner: string,
    repo: string,
    sessionId: string,
    events: SpooledEvent[],
    producerId: string,
  ): Promise<AppendOutcome> {
    const url = new URL(`/api/adp/repos/${owner}/${repo}/sessions/${sessionId}/events`, this.baseUrl);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ events, producer_id: producerId }),
      });
    } catch (err) {
      // The case the spool exists for: nothing was delivered, nothing is lost,
      // and the same batch goes again after a backoff.
      return { outcome: "unavailable", status: null, message: err instanceof Error ? err.message : String(err) };
    }

    if (res.status === 201) {
      const body = (await res.json()) as {
        appended: number;
        duplicates: string[];
        count: number;
        head: string;
        accepted_through: number | null;
      };
      return {
        outcome: "accepted",
        appended: body.appended,
        duplicates: body.duplicates ?? [],
        count: body.count,
        head: body.head,
        acceptedThrough: body.accepted_through,
      };
    }

    const text = await res.text();

    // 409 is two different things and only one of them is recoverable here.
    // A non-contiguous batch names where to replay from, which is a complete
    // instruction; a closed session is not something a retry can fix.
    if (res.status === 409) {
      let expected: number | undefined;
      let message = text;
      try {
        const body = JSON.parse(text) as { message?: string; expected_next_seq?: number };
        expected = body.expected_next_seq;
        message = body.message ?? text;
      } catch {
        /* fall through to the refusal below */
      }
      if (typeof expected === "number") return { outcome: "gap", expectedNextSeq: expected, message };
      return { outcome: "refused", status: res.status, message };
    }

    // 403 is the org storage quota, and it is the one refusal that clears
    // without anyone touching this process — an operator raises the ceiling,
    // or the meter catches up. Retryable, on a long backoff.
    if (res.status === 403 || res.status >= 500 || res.status === 429) {
      return { outcome: "unavailable", status: res.status, message: text };
    }

    // 422 (validation, byte ceiling, a secret under `on_secret: refuse`), 401,
    // 404. None of these becomes true by waiting.
    return { outcome: "refused", status: res.status, message: text };
  }
}
