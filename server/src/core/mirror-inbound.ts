import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "./git-backend.js";
import type { Signer } from "./signing.js";
import { identities, mirrors, mirrorSyncLog } from "../db/schema.js";
import { decryptCredential, redactUrl } from "./mirror-crypto.js";
import { recordPushedCommits, type RecordActor } from "./change-recorder.js";

// Bringing one upstream branch into this instance.
//
// Extracted from the webhook route by #228, and the extraction is the point
// rather than a tidy-up. Inbound has two arrivals now — a delivery GitHub
// pushes, and a poll this instance pulls — and they must produce the identical
// record, because the whole claim of 5-5 is that a developer without a public
// hostname is not on a degraded version of companion mode. Two copies of the
// divergence handling, the compare-and-swap and the sync-log accounting would
// have agreed on the day they were written and not for long after.

export type MirrorRow = typeof mirrors.$inferSelect;

export interface BranchSyncResult {
  ok: boolean;
  /** `moved` when the ref advanced, `unchanged` when it was already there. */
  outcome?: "moved" | "unchanged";
  reason?: "diverged" | "concurrent-update" | "error";
  sha?: string;
}

export function remoteUrlWithCredential(remoteUrl: string, credential: string): string {
  const url = new URL(remoteUrl);
  url.username = "x-access-token";
  url.password = credential;
  return url.toString();
}

/**
 * Fetch one branch from upstream, fast-forward the local ref, and record a
 * signed change per new commit.
 *
 * Never force-moves: a ref whose upstream history is not a descendant of what
 * is here is recorded as `diverged` and left alone. Losing a compare-and-swap
 * is likewise reported rather than retried, because the caller that lost knows
 * something else moved the ref and a blind retry would be a second attempt to
 * do what already happened.
 */
export async function syncBranchFromUpstream(
  db: Db,
  gitBackend: GitBackend,
  signer: Signer,
  credentialKey: string,
  mirror: MirrorRow,
  repo: { id: string; owner: string; name: string },
  branch: string,
  // #230: who wrote each commit, where the caller knows. The webhook reads it
  // off the push payload; the poller reads it off the commits API, which is
  // strictly better because that one carries numeric user ids.
  actorForSha?: Map<string, RecordActor>,
): Promise<BranchSyncResult> {
  const { owner, name } = repo;
  const remoteRef = `refs/heads/${branch}`;
  const currentSha = await gitBackend.resolveRef(owner, name, branch);

  try {
    // The credential is not needed to fetch a public repository, but a mirror
    // is configured against the same PAT the outbound push uses — reusing it
    // here is what makes a private upstream work identically.
    const url = remoteUrlWithCredential(mirror.remoteUrl, decryptCredential(mirror.credentialCiphertext, credentialKey));
    const fetchedSha = await gitBackend.fetchFromRemote(owner, name, url, remoteRef);

    if (currentSha === fetchedSha) return { ok: true, outcome: "unchanged", sha: fetchedSha };

    const isFastForward = currentSha === null || (await gitBackend.isAncestor(owner, name, currentSha, fetchedSha));
    if (!isFastForward) {
      await logSync(db, mirror.id, remoteRef, fetchedSha, "failed", `diverged: ${remoteRef} is not an ancestor of the fetched commit`);
      return { ok: false, reason: "diverged", sha: fetchedSha };
    }

    let moved: boolean;
    if (currentSha) {
      moved = await gitBackend.fastForwardRef(owner, name, branch, currentSha, fetchedSha);
    } else {
      await gitBackend.createRef(owner, name, remoteRef, fetchedSha);
      moved = true;
    }
    if (!moved) {
      await logSync(db, mirror.id, remoteRef, fetchedSha, "failed", "ref moved concurrently, retry");
      return { ok: false, reason: "concurrent-update", sha: fetchedSha };
    }

    const [identity] = mirror.identityId
      ? await db.select().from(identities).where(eq(identities.id, mirror.identityId))
      : [];
    if (identity) {
      await recordPushedCommits(
        db,
        gitBackend,
        signer,
        owner,
        name,
        repo.id,
        { id: identity.id, kind: identity.kind, principal: identity.principal },
        currentSha ?? "0".repeat(40),
        fetchedSha,
        "mirror-inbound",
        actorForSha,
      );
    }

    await logSync(db, mirror.id, remoteRef, fetchedSha, "success");
    await db.update(mirrors).set({ lastInboundSha: fetchedSha, updatedAt: new Date() }).where(eq(mirrors.id, mirror.id));
    return { ok: true, outcome: "moved", sha: fetchedSha };
  } catch (err) {
    await logSync(
      db,
      mirror.id,
      remoteRef,
      currentSha ?? "0".repeat(40),
      "failed",
      redactUrl(err instanceof Error ? err.message : String(err)),
    );
    return { ok: false, reason: "error" };
  }
}

async function logSync(
  db: Db,
  mirrorId: string,
  ref: string,
  sha: string,
  status: "success" | "failed",
  lastError?: string,
): Promise<void> {
  await db.insert(mirrorSyncLog).values({
    mirrorId,
    direction: "inbound",
    ref,
    sha,
    status,
    ...(lastError ? { lastError } : {}),
  });
}
