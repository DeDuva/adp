import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { changes, gateResults, intents, issues, proposals, runs, sessionEvents, sessions } from "../db/schema.js";

export interface EvidenceBundle {
  git_sha: string;
  change: {
    id: string;
    intent_id: string | null;
    /**
     * #189: the intent itself, not only its id — the unmet half of PLAN.md
     * 1a's exit criterion ("the evidence bundle names that intent by title").
     * A reader holding the artifact the whole product points at could not
     * answer "what was this change for" without a second round trip against a
     * route they had to already know existed.
     *
     * Title, deliberately not body. An evidence bundle is read to answer why
     * a line exists, and a title answers that; the body is the intent's own
     * record, belongs behind its own read where it can be paginated, and
     * would inflate every bundle for a question most readers are not asking.
     *
     * Null when the change is unbound — which is an ordinary state, not an
     * error: a commit pushed without an intent trailer and never bound
     * afterwards has no intent to name.
     */
    intent: { id: string; title: string; issue_number: number | null } | null;
    provenance: unknown;
    signature: string;
    created_at: string;
  } | null;
  gates: {
    name: string;
    status: string;
    summary: string;
    envelope: unknown;
    created_at: string;
  }[];
  /**
   * #157: how to get from this commit to what produced it.
   *
   * **Navigation, not evidence.** Nothing here is signed and none of it changes
   * what the bundle attests — it is the same kind of resolution #189 added when
   * it put the intent's title beside its id, for the same reason. JTBD-2 is
   * "when a change lands wrong, I want to know what the agent was trying to
   * do", and without this a reader is holding the identifier of the thing they
   * want and has no way to follow it.
   *
   * Every edge here is a join over data that already exists. `sessions` comes
   * off `session_events.git_sha`, which is on commit events precisely so this
   * join needs no payload parsing.
   */
  produced_by: {
    sessions: { id: string; harness: string; run_id: string | null; seq: number }[];
    runs: { id: string; orchestrator: string; labels: Record<string, string>; status: string }[];
    proposals: { number: number; title: string; state: string }[];
  };
}

// "adp_evidence_get — full signed bundle for a change" (
// Tier 4). Not a new source of truth — a read that assembles what's already
// signed and stored elsewhere: the change record (core/signing.ts) and every
// gate result reported for that commit (core/dsse.ts), most-recent-first.
export async function getEvidenceBundle(db: Db, repoId: string, gitSha: string): Promise<EvidenceBundle> {
  // #143 made (repo_id, git_sha) unique, so this can match at most one row.
  // The ordering and the limit stay anyway: this read is what decides whether
  // an evidence bundle shows an intent at all, and it should not be the
  // constraint alone standing between that answer and an arbitrary one. If a
  // future write path ever reintroduces a second row, this returns the oldest
  // — the push's record — deterministically, rather than whatever the plan
  // happened to yield.
  const [change] = await db
    .select()
    .from(changes)
    .where(and(eq(changes.repoId, repoId), eq(changes.gitSha, gitSha)))
    .orderBy(asc(changes.createdAt), asc(changes.id))
    .limit(1);

  // One extra query, and only when there is something to look up. Joining it
  // into the select above would mean a left join on the hot path for a field
  // that is null whenever the change is unbound, which is the common shape on
  // a repo that does not use trailers.
  const [intent] = change?.intentId
    ? await db.select({ id: intents.id, title: intents.title }).from(intents).where(eq(intents.id, change.intentId))
    : [];

  // #157: the issue that carries this intent, so the bundle names something a
  // person can navigate to rather than a uuid they must already know how to
  // look up. Null is ordinary rather than exceptional — `intents.source` is
  // `issue`, `task` or `api`, and only the first has a number.
  const [issue] = intent
    ? await db
        .select({ number: issues.number })
        .from(issues)
        .where(and(eq(issues.repoId, repoId), eq(issues.intentId, intent.id)))
        .orderBy(asc(issues.number))
        .limit(1)
    : [];

  const gateRows = await db
    .select()
    .from(gateResults)
    .where(and(eq(gateResults.repoId, repoId), eq(gateResults.gitSha, gitSha)));

  const producedBy = await producedByFor(db, repoId, gitSha, change?.provenance);

  return {
    git_sha: gitSha,
    change: change
      ? {
          id: change.id,
          intent_id: change.intentId,
          intent: intent ? { ...intent, issue_number: issue?.number ?? null } : null,
          provenance: change.provenance,
          signature: change.signature,
          created_at: change.createdAt.toISOString(),
        }
      : null,
    gates: gateRows
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((row) => ({
        name: row.name,
        status: row.status,
        summary: row.summary,
        envelope: row.envelope,
        created_at: row.createdAt.toISOString(),
      })),
    produced_by: producedBy,
  };
}

// The three edges out of a commit, each a join over a column that already
// exists for this purpose.
//
// It runs for every bundle rather than behind a flag, because a navigation
// affordance nobody knows to ask for is one nobody uses — and the cost is three
// indexed reads against a single sha, not a scan.
async function producedByFor(
  db: Db,
  repoId: string,
  gitSha: string,
  provenance: unknown,
): Promise<EvidenceBundle["produced_by"]> {
  // `session_events.git_sha` is set on commit events, which is the whole reason
  // the column is typed rather than left inside the payload: this join needs no
  // payload parsing, and the payload is opaque to the server by invariant.
  const commitEvents = await db
    .select({ sessionId: sessionEvents.sessionId, seq: sessionEvents.seq })
    .from(sessionEvents)
    .where(eq(sessionEvents.gitSha, gitSha))
    .orderBy(asc(sessionEvents.seq));

  // And the *other* way a commit names a session, which is the one #157's
  // second done-when is actually about: a plain `git push` carrying an
  // `ADP-Session` trailer records the id in the change's provenance, not as a
  // trajectory event. A join on `session_events` alone answers only for commits
  // some recorder happened to observe — so the path would work for a commit
  // made through the API and not for the ordinary one, which is precisely
  // backwards.
  const fromTrailer =
    provenance && typeof provenance === "object" && "session_id" in provenance
      ? (provenance as { session_id?: unknown }).session_id
      : undefined;
  const trailerSessionId = typeof fromTrailer === "string" ? fromTrailer : undefined;

  const sessionIds = [
    ...new Set([...commitEvents.map((e) => e.sessionId), ...(trailerSessionId ? [trailerSessionId] : [])]),
  ];
  // Scoped to this repository. `session_events` has no repo column, so an
  // unscoped join would let a commit sha that exists in two repositories name
  // the other one's sessions — the sha is the caller's input, and a sha is not
  // a secret.
  const sessionRows =
    sessionIds.length === 0
      ? []
      : await db
          .select({ id: sessions.id, harness: sessions.harness, runId: sessions.runId })
          .from(sessions)
          .where(and(inArray(sessions.id, sessionIds), eq(sessions.repoId, repoId)));
  // Where in the session the commit was recorded, when it was recorded there at
  // all. A session known only from a trailer has no such event, and 0 says so —
  // it is not a seq, because seqs are 1-based.
  const firstSeq = new Map<string, number>();
  for (const e of commitEvents) if (!firstSeq.has(e.sessionId)) firstSeq.set(e.sessionId, e.seq);

  // The runs those sessions belong to, plus any run that closed against this
  // commit — a run whose final sha this is, but whose sessions recorded no
  // commit event, is still the run that produced it.
  const runIds = [
    ...new Set(sessionRows.map((s) => s.runId).filter((id): id is string => id !== null)),
  ];
  const runMatch =
    runIds.length === 0
      ? eq(runs.finalGitSha, gitSha)
      : or(inArray(runs.id, runIds), eq(runs.finalGitSha, gitSha));
  const runRows = await db
    .select({
      id: runs.id,
      orchestrator: runs.orchestrator,
      labels: runs.labels,
      status: runs.status,
    })
    .from(runs)
    .where(and(eq(runs.repoId, repoId), runMatch))
    .orderBy(asc(runs.createdAt));

  const proposalRows = await db
    .select({ number: proposals.number, title: proposals.title, state: proposals.state })
    .from(proposals)
    .where(and(eq(proposals.repoId, repoId), eq(proposals.headSha, gitSha)))
    .orderBy(asc(proposals.number));

  return {
    sessions: sessionRows.map((s) => ({
      id: s.id,
      harness: s.harness,
      run_id: s.runId,
      seq: firstSeq.get(s.id) ?? 0,
    })),
    runs: runRows.map((r) => ({
      id: r.id,
      orchestrator: r.orchestrator,
      labels: (r.labels ?? {}) as Record<string, string>,
      status: r.status,
    })),
    proposals: proposalRows,
  };
}
