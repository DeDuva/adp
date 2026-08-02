import { eq, asc, and } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "./git-backend.js";
import { mirrors, mirrorSyncLog, repos } from "../db/schema.js";
import { decryptCredential, redactUrl } from "./mirror-crypto.js";

const BATCH_SIZE = 20;

// Builds a push/fetch URL with the mirror's decrypted credential embedded
// as basic-auth (GitHub's own convention for PAT-over-HTTPS:
// https://<token>@github.com/owner/repo.git), so it's never passed as a
// separate CLI arg or written to .git/config (see GitBackend.pushToRemote).
function remoteUrlWithCredential(remoteUrl: string, credential: string): string {
  const url = new URL(remoteUrl);
  url.username = "x-access-token";
  url.password = credential;
  return url.toString();
}

// Drains the mirror_sync_log outbox: rows are enqueued synchronously inside
// the post-receive hook's transaction (http-git/hooks.ts) so `git push`
// latency never depends on GitHub's availability; this poller does the
// actual network call out-of-band, retryable and independently testable.
// `FOR UPDATE SKIP LOCKED` makes this safe even with more than one poller
// instance running concurrently, though v0 only ever runs one.
export async function pollOnce(db: Db, gitBackend: GitBackend, credentialKey: string): Promise<void> {
  // SELECT ... FOR UPDATE SKIP LOCKED only holds its lock for the
  // transaction's lifetime — claim the batch (select + mark in_progress) in
  // one transaction so a concurrent poller instance can't double-claim a row,
  // then release the lock (transaction commits) before doing the actual
  // network pushes below, which shouldn't hold a row lock for their duration.
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(mirrorSyncLog)
      .where(and(eq(mirrorSyncLog.status, "pending"), eq(mirrorSyncLog.direction, "outbound")))
      .orderBy(asc(mirrorSyncLog.createdAt))
      .limit(BATCH_SIZE)
      .for("update", { skipLocked: true });

    for (const row of rows) {
      await tx.update(mirrorSyncLog).set({ status: "in_progress", updatedAt: new Date() }).where(eq(mirrorSyncLog.id, row.id));
    }
    return rows;
  });

  for (const row of claimed) {
    const [mirror] = await db.select().from(mirrors).where(eq(mirrors.id, row.mirrorId));
    if (!mirror) {
      await db
        .update(mirrorSyncLog)
        .set({ status: "failed", lastError: "mirror config no longer exists", updatedAt: new Date() })
        .where(eq(mirrorSyncLog.id, row.id));
      continue;
    }

    const [repo] = await db.select().from(repos).where(eq(repos.id, mirror.repoId));
    if (!repo) {
      await db
        .update(mirrorSyncLog)
        .set({ status: "failed", lastError: "repo no longer exists", updatedAt: new Date() })
        .where(eq(mirrorSyncLog.id, row.id));
      continue;
    }

    try {
      const credential = decryptCredential(mirror.credentialCiphertext, credentialKey);
      const url = remoteUrlWithCredential(mirror.remoteUrl, credential);
      await gitBackend.pushToRemote(repo.owner, repo.name, url, `${row.sha}:${row.ref}`);

      await db
        .update(mirrorSyncLog)
        .set({ status: "success", updatedAt: new Date() })
        .where(eq(mirrorSyncLog.id, row.id));
      await db
        .update(mirrors)
        .set({ lastOutboundSha: row.sha, updatedAt: new Date() })
        .where(eq(mirrors.id, mirror.id));
    } catch (err) {
      const message = redactUrl(err instanceof Error ? err.message : String(err));
      await db
        .update(mirrorSyncLog)
        .set({
          status: "failed",
          attempts: row.attempts + 1,
          lastError: message,
          updatedAt: new Date(),
        })
        .where(eq(mirrorSyncLog.id, row.id));
    }
  }
}

export function startMirrorPoller(db: Db, gitBackend: GitBackend, credentialKey: string, intervalMs: number): NodeJS.Timeout {
  return setInterval(() => {
    pollOnce(db, gitBackend, credentialKey).catch((err) => {
      console.error("mirror poller tick failed:", err);
    });
  }, intervalMs);
}
