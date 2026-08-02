import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { Signer } from "./signing.js";
import type { CommitInfo } from "./git-backend.js";
import { changes, type identities } from "../db/schema.js";
import { recordOperation } from "./operations.js";

type IdentityRow = typeof identities.$inferSelect;

// The auto-record loop shared by an ordinary push's post-receive hook
// (http-git/hooks.ts) and mirror mode's inbound ingest (core/mirror.ts) —
// same signed `changes` row + `change.create` operation either way, only
// `via` differs. Dedups against `changes (repo_id, git_sha)`: a commit
// that's already recorded (the common case on a re-fetch, or history two
// branches share) is silently skipped, not re-signed.
export async function recordNewCommits(
  db: Db,
  signer: Signer,
  repo: { id: string },
  owner: string,
  name: string,
  identity: Pick<IdentityRow, "id" | "kind" | "principal">,
  commits: CommitInfo[],
  via: string,
): Promise<void> {
  for (const commit of commits) {
    const [existing] = await db
      .select()
      .from(changes)
      .where(and(eq(changes.repoId, repo.id), eq(changes.gitSha, commit.sha)));
    if (existing) continue;

    const provenance = { kind: identity.kind, principal: identity.principal, via };
    const signature = signer.sign({
      repo: `${owner}/${name}`,
      git_sha: commit.sha,
      intent_id: null,
      provenance,
    });

    await db.transaction(async (tx) => {
      const [change] = await tx
        .insert(changes)
        .values({ repoId: repo.id, gitSha: commit.sha, intentId: null, provenance, signature })
        .returning();

      await recordOperation(tx, {
        actorId: identity.id,
        verb: "change.create",
        target: `${owner}/${name}@${commit.sha}`,
        after: { id: change!.id, gitSha: commit.sha, via },
      });
    });
  }
}
