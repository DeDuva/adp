import { and, asc, eq, isNull, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "./git-backend.js";
import { repos, workspaces } from "../db/schema.js";
import { destroyWorkspace } from "./workspaces.js";

const BATCH_SIZE = 50;

// M4-3 (docs/m4-readiness-review.md §4): generalizes M3-2's on-demand
// candidate-set reclamation to a scheduled sweep, the way the milestone's own
// text puts it. Reuses destroyWorkspace() rather than duplicating its ref
// deletion + recordOperation logic — this is a caller of that function, not
// a second implementation of it.
//
// Same claim-then-release-the-lock shape as mirror-poller.ts's pollOnce, and
// the same accepted narrow race: FOR UPDATE SKIP LOCKED keeps two concurrent
// ticks from grabbing the *same* row, but the lock releases at the claiming
// transaction's commit, before destroyWorkspace's own fresh read-and-check —
// same window land.ts's TOCTOU comment already documents and accepts
// elsewhere in this codebase. Low stakes here specifically: destroying an
// already-destroyed workspace is a harmless no-op (destroyWorkspace's own
// existence check refuses it), not lost work or a duplicated external effect.
export async function sweepExpiredWorkspaces(
  db: Db,
  gitBackend: GitBackend,
  actorId: string,
): Promise<{ swept: number; failed: number }> {
  const claimed = await db.transaction(async (tx) => {
    return tx
      .select()
      .from(workspaces)
      .where(and(isNull(workspaces.destroyedAt), lt(workspaces.expiresAt, new Date())))
      .orderBy(asc(workspaces.expiresAt))
      .limit(BATCH_SIZE)
      .for("update", { skipLocked: true });
  });

  let swept = 0;
  let failed = 0;
  for (const workspace of claimed) {
    const [repo] = await db.select().from(repos).where(eq(repos.id, workspace.repoId));
    if (!repo) {
      failed++;
      continue;
    }
    // One bad workspace must not take the batch down with it: an unexpected
    // throw here used to abort the entire sweep, so every workspace sorted
    // after the broken one stayed unreclaimed on every subsequent tick —
    // the sweeper was wedged by exactly the kind of row it exists to clean.
    try {
      const result = await destroyWorkspace(db, gitBackend, repo, workspace.id, actorId);
      if (result.ok) swept++;
      else failed++;
    } catch (err) {
      console.error(`workspace sweep failed for ${workspace.id} (${repo.owner}/${repo.name}):`, err);
      failed++;
    }
  }
  return { swept, failed };
}

export function startWorkspaceSweeper(
  db: Db,
  gitBackend: GitBackend,
  actorId: string,
  intervalMs: number,
): NodeJS.Timeout {
  return setInterval(() => {
    sweepExpiredWorkspaces(db, gitBackend, actorId).catch((err) => {
      console.error("workspace sweeper tick failed:", err);
    });
  }, intervalMs);
}
