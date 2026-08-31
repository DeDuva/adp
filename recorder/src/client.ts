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

export interface Checkpoint {
  id: string;
  seq: number;
  git_sha: string;
}

/** Why a checkpoint did not happen, kept apart from "it did" so a caller can retry the right ones. */
export type CheckpointOutcome =
  | { outcome: "created"; checkpoint: Checkpoint }
  /** The commit is not in ADP yet — a local commit nobody has pushed. Retryable at the next boundary. */
  | { outcome: "unresolvable"; message: string }
  | { outcome: "failed"; message: string };

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

  /**
   * Resume a session, producing a new one linked to it.
   *
   * The server picks the latest checkpoint when none is named, verifies its
   * signature, and refuses the resume rather than linking to state it cannot
   * vouch for. All of which is why this is a thin call: the hard part is on the
   * other side, and duplicating any of its judgement here would be a second
   * opinion nobody asked for.
   */
  async resumeSession(
    owner: string,
    repo: string,
    sessionId: string,
    body: { harness: string; checkpoint_id?: string },
  ): Promise<StartedSession> {
    const res = await this.fetchImpl(
      new URL(`/api/adp/repos/${owner}/${repo}/sessions/${sessionId}/resume`, this.baseUrl),
      { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
    );
    if (!res.ok) throw new Error(`resume session failed: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as StartedSession;
  }

  /**
   * Checkpoint, and classify the one refusal that is not a bug.
   *
   * ADP resolves `git_sha` against the repository and refuses a checkpoint
   * naming a commit it does not have — deliberately, because resume time is
   * the worst place to discover that. For a recorder watching a developer's
   * checkout that is the *ordinary* case: they commit, and they push some time
   * later. So an unresolvable sha is not an error to report and give up on, it
   * is a boundary to try again at, and telling the two apart is this method's
   * whole job.
   */
  async createCheckpoint(
    owner: string,
    repo: string,
    sessionId: string,
    body: { git_sha: string; harness?: string; state: unknown },
  ): Promise<CheckpointOutcome> {
    let res: Response;
    try {
      res = await this.fetchImpl(
        new URL(`/api/adp/repos/${owner}/${repo}/sessions/${sessionId}/checkpoints`, this.baseUrl),
        { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
      );
    } catch (err) {
      return { outcome: "failed", message: err instanceof Error ? err.message : String(err) };
    }
    if (res.status === 201) return { outcome: "created", checkpoint: (await res.json()) as Checkpoint };
    const text = await res.text();
    if (res.status === 422 && text.includes("could not be resolved")) {
      return { outcome: "unresolvable", message: text };
    }
    return { outcome: "failed", message: `HTTP ${res.status} ${text}` };
  }

  /**
   * End a session as closed or as suspended.
   *
   * Suspended is what an interrupted recorder reports, and the reason it is a
   * status rather than an absence: an unclosed session is indistinguishable
   * from an abandoned one, and `runs.close` binds every session's chain head.
   */
  async endSession(
    owner: string,
    repo: string,
    sessionId: string,
    status: "closed" | "suspended",
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(`/api/adp/repos/${owner}/${repo}/sessions/${sessionId}/close`, this.baseUrl), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ status }),
      });
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    if (res.ok) return { ok: true };
    return { ok: false, message: `HTTP ${res.status} ${await res.text()}` };
  }

  /**
   * Resolve what an `ADP-Intent` trailer names into the id `POST /sessions`
   * takes.
   *
   * A trailer may be a UUID, `#41` or `41` — the server accepts all three on
   * the push path, and the session route accepts only the first. Rather than
   * making the recorder's user learn that distinction, the two reference forms
   * are looked up as issue numbers, which is what they are.
   */
  async resolveIntent(owner: string, repo: string, reference: string): Promise<string | null> {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reference)) return reference;
    const number = /^#?(\d+)$/.exec(reference)?.[1];
    if (!number) return null;
    try {
      const res = await this.fetchImpl(new URL(`/api/v3/repos/${owner}/${repo}/issues/${number}`, this.baseUrl), {
        headers: { Authorization: `Bearer ${this.token}` },
        // The one call the recorder makes *before* it starts recording, which
        // is why it is the one call with a deadline. #149's guarantee is that
        // an unreachable ADP costs nothing — and an unreachable host, as
        // opposed to a refused port, does not fail fast: without this, a
        // recorder started against a server that is merely gone would sit in
        // the kernel's TCP timeout while the session it was supposed to be
        // capturing went by.
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { intent_id?: string };
      return body.intent_id ?? null;
    } catch {
      return null;
    }
  }
}
