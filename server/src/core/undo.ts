import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "./git-backend.js";
import { operations, proposals } from "../db/schema.js";
import { recordOperation } from "./operations.js";

export interface UndoResult {
  ok: boolean;
  message?: string;
}

// The one undo case implemented in this slice (docs/pragmatic_mvp.md M1c,
// native plane — "no GitHub analogue"): reverting a fast-forward merge.
// Only safe if the base ref hasn't moved since — otherwise winding it back
// would silently drop whatever landed after. Other verbs aren't undoable
// yet (an honest 422, not a no-op that pretends to have worked).
export async function undoOperation(
  db: Db,
  gitBackend: GitBackend,
  repo: { id: string; owner: string; name: string },
  entry: typeof operations.$inferSelect,
  actorId: string,
): Promise<UndoResult> {
  if (entry.verb !== "proposal.merge") {
    return { ok: false, message: `verb '${entry.verb}' is not undoable` };
  }

  const alreadyUndone = await db.select().from(operations).where(eq(operations.parentOp, entry.id));
  if (alreadyUndone.length > 0) {
    return { ok: false, message: "this merge has already been undone" };
  }

  const after = entry.after as { baseSha: string; mergedInto: string } | null;
  const before = entry.before as { baseSha: string } | null;
  if (!after?.baseSha || !after.mergedInto || !before?.baseSha) {
    return { ok: false, message: "operation is missing the before/after state needed to undo it" };
  }

  const numberMatch = /#(\d+)$/.exec(entry.target);
  const number = numberMatch ? Number(numberMatch[1]) : null;
  const [proposal] = number
    ? await db.select().from(proposals).where(and(eq(proposals.repoId, repo.id), eq(proposals.number, number)))
    : [];
  if (!proposal || proposal.state !== "merged") {
    return { ok: false, message: "the merged proposal this operation refers to can't be found" };
  }

  // fastForwardRef is just an atomic compare-and-swap (git update-ref old
  // new) — nothing about it actually requires moving forward; reused here
  // to move the ref *back*, guarded the same way: only if it still points
  // where the merge left it.
  const reverted = await gitBackend.fastForwardRef(repo.owner, repo.name, after.mergedInto, after.baseSha, before.baseSha);
  if (!reverted) {
    return {
      ok: false,
      message: `'${after.mergedInto}' has moved since this merge — undoing now would drop later work`,
    };
  }

  await db.transaction(async (tx) => {
    await tx.update(proposals).set({ state: "open", mergedAt: null }).where(eq(proposals.id, proposal.id));

    await recordOperation(tx, {
      repoId: repo.id,
      actorId,
      verb: "proposal.merge.undo",
      target: entry.target,
      before: { baseSha: after.baseSha },
      after: { baseSha: before.baseSha },
      parentOp: entry.id,
    });
  });

  return { ok: true };
}
