import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessionEvents, sessions } from "../db/schema.js";

// Which model actually produced a change, as opposed to which one was claimed.
//
// `provenance.model` comes from the token, which took it from whatever
// `adp connect` or the mint call asserted — once, at connect time. A harness can
// change model inside a single run, and the session event schema has recorded
// `model` per event since the trajectory slice landed, because that was
// anticipated. So the field ADP publishes as "which model produced this" was an
// assertion, while the observation sat in the trajectory unread.
//
// That matters beyond tidiness. 2-4 (#176) prices an approval by the model and
// harness that produced the change; pricing a separation-of-judgment control on
// a self-asserted string is the same category error 2-4 exists to correct one
// level down.
//
// **The assertion is not deleted, and the observation does not replace it in the
// signed record.** A change is signed when it is pushed and the trajectory
// arrives out of band — the recorder batches, and may ship after the push — so
// signing an observation not yet made is not available. What is available, and
// is what this returns, is both facts with a label saying which one is load
// bearing. That is the same honesty the trajectory reader already applies to a
// reduced payload: showing something weaker is fine, showing it as though it
// were the stronger thing is not.

export interface ObservedModel {
  /**
   * Distinct models seen in the trajectory, in the order they were first used.
   *
   * An array rather than a value because a run in which the model changed is a
   * different historical fact from one that used a single model, and
   * collapsing it to "the last one" or "the most common one" would erase
   * exactly the case #176 has to be able to price.
   */
  observed: string[];
  /** What the token claimed. Kept because "the harness said this" is a real, weaker fact. */
  asserted: string | null;
  /**
   * Which of the two a reader should treat as load bearing.
   *
   * `asserted` means a harness with no reader produced this — the documented
   * degraded mode, said out loud rather than passed off as an observation.
   * `none` means neither is available, which is an ordinary state for a commit
   * a person wrote.
   */
  source: "observed" | "asserted" | "none";
}

/**
 * The models observed across a set of sessions.
 *
 * Reads the typed `model` column rather than anything in the payload, which is
 * what makes it survive #161's retention: an aged-out event keeps every typed
 * column and loses only its payload body, so the observation outlives the
 * transcript it was made from.
 */
export async function observedModels(db: Db, repoId: string, sessionIds: string[]): Promise<string[]> {
  if (sessionIds.length === 0) return [];

  // Scoped to the repository, for the same reason producedByFor scopes its
  // session lookup: `session_events` has no repo column, and a caller-supplied
  // sha must not be able to reach another repository's trajectory.
  const rows = await db
    .select({ model: sessionEvents.model, seq: sessionEvents.seq, sessionId: sessionEvents.sessionId })
    .from(sessionEvents)
    .innerJoin(sessions, eq(sessionEvents.sessionId, sessions.id))
    .where(
      and(
        inArray(sessionEvents.sessionId, sessionIds),
        eq(sessions.repoId, repoId),
        isNotNull(sessionEvents.model),
      ),
    )
    .orderBy(asc(sessionEvents.seq));

  const seen: string[] = [];
  for (const row of rows) {
    const model = row.model!;
    if (!seen.includes(model)) seen.push(model);
  }
  return seen;
}

/** Both facts about a change's model, with the label saying which one to trust. */
export async function modelFor(
  db: Db,
  repoId: string,
  sessionIds: string[],
  provenance: unknown,
): Promise<ObservedModel> {
  const asserted =
    provenance && typeof provenance === "object" && "model" in provenance
      ? ((provenance as { model?: unknown }).model ?? null)
      : null;
  const assertedModel = typeof asserted === "string" ? asserted : null;

  const observed = await observedModels(db, repoId, sessionIds);
  return {
    observed,
    asserted: assertedModel,
    source: observed.length > 0 ? "observed" : assertedModel ? "asserted" : "none",
  };
}
