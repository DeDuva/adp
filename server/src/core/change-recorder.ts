import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "./git-backend.js";
import type { Signer } from "./signing.js";
import { changes } from "../db/schema.js";
import { recordOperation } from "./operations.js";

const ZERO_SHA = "0".repeat(40);

export interface RecordActor {
  id: string;
  kind: string;
  principal: string;
}

// Shared by the post-receive hook (a direct push through ADP) and the
// inbound mirror webhook (a fetch of a push that landed straight on
// GitHub) — both auto-record a typed `changes` row per new commit the same
// way, distinguished only by `via` in the signed provenance.
export async function recordPushedCommits(
  db: Db,
  gitBackend: GitBackend,
  signer: Signer,
  owner: string,
  name: string,
  repoId: string,
  actor: RecordActor,
  oldSha: string,
  newSha: string,
  via: "push" | "mirror-inbound",
): Promise<void> {
  if (newSha === ZERO_SHA) return;

  // A brand-new branch (oldSha all-zero) usually forks from history that's
  // already recorded via whatever ref it was pushed from — recording the
  // tip only (not the whole reachable history) avoids re-recording
  // everything on every new branch. `existing change` dedup below covers
  // the rest regardless.
  const commits =
    oldSha === ZERO_SHA
      ? await gitBackend.log(owner, name, newSha, 1)
      : await gitBackend.log(owner, name, `${oldSha}..${newSha}`, 500);

  for (const commit of commits) {
    const [existing] = await db
      .select()
      .from(changes)
      .where(and(eq(changes.repoId, repoId), eq(changes.gitSha, commit.sha)));
    if (existing) continue;

    const provenance = { kind: actor.kind, principal: actor.principal, via };
    const signature = signer.sign({
      repo: `${owner}/${name}`,
      git_sha: commit.sha,
      intent_id: null,
      provenance,
    });

    await db.transaction(async (tx) => {
      const [change] = await tx
        .insert(changes)
        .values({ repoId, gitSha: commit.sha, intentId: null, provenance, signature })
        .returning();

      await recordOperation(tx, {
        actorId: actor.id,
        verb: "change.create",
        target: `${owner}/${name}@${commit.sha}`,
        after: { id: change!.id, gitSha: commit.sha, via },
      });
    });
  }
}
