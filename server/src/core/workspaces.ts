import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "./git-backend.js";
import { workspaces } from "../db/schema.js";
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
  repo: { id: string; owner: string; name: string },
  baseRef: string,
  actorId: string,
  ttlHours: number | undefined,
): Promise<CreateWorkspaceResult | CreateWorkspaceError> {
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
