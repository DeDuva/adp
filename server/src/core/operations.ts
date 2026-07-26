import type { Db } from "../db/client.js";
import { operations } from "../db/schema.js";

export interface OperationEntry {
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
// forgotten silently.
export async function recordOperation(tx: Pick<Db, "insert">, entry: OperationEntry): Promise<void> {
  await tx.insert(operations).values({
    actorId: entry.actorId,
    verb: entry.verb,
    target: entry.target,
    before: entry.before ?? null,
    after: entry.after ?? null,
    parentOp: entry.parentOp ?? null,
  });
}
