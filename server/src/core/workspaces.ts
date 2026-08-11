import { randomUUID } from "node:crypto";
import { and, count, eq, isNull } from "drizzle-orm";
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
  // M4-3: counted across every repo in the org, not just this one — the
  // quota is an org-wide ceiling on live workspaces, the resource GC exists
  // to reclaim, so it has to be checked at org scope for either to mean
  // anything.
  if (repo.orgId) {
    const [org] = await db.select({ maxConcurrentWorkspaces: orgs.maxConcurrentWorkspaces }).from(orgs).where(eq(orgs.id, repo.orgId));
    if (org?.maxConcurrentWorkspaces != null) {
      const [row] = await db
        .select({ live: count() })
        .from(workspaces)
        .innerJoin(repos, eq(workspaces.repoId, repos.id))
        .where(and(eq(repos.orgId, repo.orgId), isNull(workspaces.destroyedAt)));
      if ((row?.live ?? 0) >= org.maxConcurrentWorkspaces) {
        return {
          ok: false,
          message: `org concurrent-workspace quota exceeded (max ${org.maxConcurrentWorkspaces})`,
        };
      }
    }
  }

  const baseSha = await gitBackend.resolveRef(repo.owner, repo.name, baseRef);
  if (!baseSha) {
    return { ok: false, message: `base ref '${baseRef}' not found` };
  }

  const branch = `adp/ws/${randomUUID()}`;
  await gitBackend.createRef(repo.owner, repo.name, `refs/heads/${branch}`, baseSha);

  const expiresAt = ttlHours ? new Date(Date.now() + ttlHours * 3600_000) : null;

  const workspace = await db.transaction(async (tx) => {
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

    return workspace!;
  });

  return { ok: true, workspace };
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

  await gitBackend.deleteRef(repo.owner, repo.name, `refs/heads/${workspace.branch}`);

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
