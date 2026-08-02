import type { Db } from "../db/client.js";
import { operations } from "../db/schema.js";

export interface OperationEntry {
  repoId: string | null;
  actorId: string;
  verb: string;
  target: string;
  before?: unknown;
  after?: unknown;
  parentOp?: string;
}

// The hard invariant (docs/pragmatic_mvp.md §4.2): every mutation writes its
// state change and its operations row in the same transaction. Callers pass
// the transaction handle, not the top-level db, so this can never be
// forgotten silently. `repoId` is required (not defaulted) so a call site
// can't forget it silently the way the pre-M2 schema let every op forget it —
// pass `null` explicitly for the (currently nonexistent) genuinely global verb.
export async function recordOperation(tx: Pick<Db, "insert">, entry: OperationEntry): Promise<void> {
  await tx.insert(operations).values({
    repoId: entry.repoId,
    actorId: entry.actorId,
    verb: entry.verb,
    target: entry.target,
    before: entry.before ?? null,
    after: entry.after ?? null,
    parentOp: entry.parentOp ?? null,
  });
}
