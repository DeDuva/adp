import { randomUUID } from "node:crypto";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "./git-backend.js";
import { orgs, repos, workspaces } from "../db/schema.js";
import { recordOperation } from "./operations.js";

export interface CreateWorkspaceResult {
  ok: true;
  workspace: typeof workspaces.$inferSelect;
}
export interface CreateWorkspaceError {
  ok: false;
  message: string;
}

// A workspace is deliberately just a git branch with a row tracking it
// (docs/pragmatic_mvp.md §2.2: "Workspace | A branch adp/ws/<id> |
// Lifecycle, TTL, GC, isolation") — no new storage mechanism, no VFS.
export async function createWorkspace(
  db: Db,
  gitBackend: GitBackend,
  repo: { id: string; owner: string; name: string; orgId: string | null },
  baseRef: string,
  actorId: string,
  ttlHours: number | undefined,
): Promise<CreateWorkspaceResult | CreateWorkspaceError> {
  const baseSha = await gitBackend.resolveRef(repo.owner, repo.name, baseRef);
  if (!baseSha) {
    return { ok: false, message: `base ref '${baseRef}' not found` };
  }

  const branch = `adp/ws/${randomUUID()}`;
  const expiresAt = ttlHours ? new Date(Date.now() + ttlHours * 3600_000) : null;

  // M4-3: the quota is counted across every repo in the org, not just this
  // one — an org-wide ceiling on live workspaces, the resource GC exists to
  // reclaim. #94 (audit §P1-3): counted INSIDE the inserting transaction,
  // behind FOR UPDATE on the org row. It used to be a separate read before
  // the transaction, so two concurrent creates both saw live = cap - 1 and
  // both passed — the ceiling was advisory exactly when contended. The org
  // row is the budget token; same-org admissions serialize on it, and the
  // branch ref is only created after the admission decision, so a refused
  // create leaves nothing behind in git.
  const admitted = await db.transaction(async (tx) => {
    if (repo.orgId) {
      await tx.execute(sql`select id from ${orgs} where id = ${repo.orgId} for update`);
      const [org] = await tx
        .select({ maxConcurrentWorkspaces: orgs.maxConcurrentWorkspaces })
        .from(orgs)
        .where(eq(orgs.id, repo.orgId));
      if (org?.maxConcurrentWorkspaces != null) {
        const [row] = await tx
          .select({ live: count() })
          .from(workspaces)
          .innerJoin(repos, eq(workspaces.repoId, repos.id))
          .where(and(eq(repos.orgId, repo.orgId), isNull(workspaces.destroyedAt)));
        if ((row?.live ?? 0) >= org.maxConcurrentWorkspaces) {
          return { ok: false as const, max: org.maxConcurrentWorkspaces };
        }
      }
    }

    await gitBackend.createRef(repo.owner, repo.name, `refs/heads/${branch}`, baseSha);

    const [workspace] = await tx
      .insert(workspaces)
      .values({ repoId: repo.id, branch, baseRef, baseSha, createdById: actorId, expiresAt })
      .returning();

    await recordOperation(tx, {
      repoId: repo.id,
      actorId,
      verb: "workspace.create",
      target: `${repo.owner}/${repo.name}@${branch}`,
      after: { id: workspace!.id, branch, baseRef, baseSha },
    });

    return { ok: true as const, workspace: workspace! };
  });

  if (!admitted.ok) {
    return { ok: false, message: `org concurrent-workspace quota exceeded (max ${admitted.max})` };
  }
  return { ok: true, workspace: admitted.workspace };
}

export interface DestroyWorkspaceResult {
  ok: boolean;
  message?: string;
}

export async function destroyWorkspace(
  db: Db,
  gitBackend: GitBackend,
  repo: { id: string; owner: string; name: string },
  workspaceId: string,
  actorId: string,
): Promise<DestroyWorkspaceResult> {
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.repoId, repo.id)));
  if (!workspace) {
    return { ok: false, message: "workspace not found" };
  }
  if (workspace.destroyedAt) {
    return { ok: false, message: "workspace already destroyed" };
  }

  // A repo whose on-disk directory is gone (deleted out from under the row,
  // or a test/tooling environment that didn't survive) definitionally has
  // no ref left to delete — closing the workspace row out is the right
  // outcome, not an error. Before this check, one such workspace poisoned
  // every sweep that reached it: deleteRef's spawn failed on the missing
  // cwd, the whole sweep batch aborted, and no workspace after it in the
  // batch was ever reclaimed.
  if (await gitBackend.exists(repo.owner, repo.name)) {
    await gitBackend.deleteRef(repo.owner, repo.name, `refs/heads/${workspace.branch}`);
  }

  await db.transaction(async (tx) => {
    await tx.update(workspaces).set({ destroyedAt: new Date() }).where(eq(workspaces.id, workspace.id));

    await recordOperation(tx, {
      repoId: repo.id,
      actorId,
      verb: "workspace.destroy",
      target: `${repo.owner}/${repo.name}@${workspace.branch}`,
      before: { destroyedAt: null },
      after: { destroyedAt: new Date().toISOString() },
    });
  });

  return { ok: true };
}
