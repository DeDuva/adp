import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend, CommitInfo } from "./git-backend.js";
import type { Signer } from "./signing.js";
import { changes } from "../db/schema.js";
import { recordOperation } from "./operations.js";

const ZERO_SHA = "0".repeat(40);

// A ref update spanning more than this many new commits (a mirrored import of
// real GitHub history, not an incremental push) is recorded page by page
// instead of via one `git log --max-count=500` call — that single call used
// to silently drop everything past the newest 500 commits, which is the one
// failure mode this product cannot have: a gap in the provenance record.
const RECORD_BATCH_SIZE = 500;

export interface RecordActor {
  id: string;
  kind: string;
  principal: string;
}

async function recordCommitsBatch(
  db: Db,
  signer: Signer,
  repoId: string,
  owner: string,
  name: string,
  actor: RecordActor,
  commits: CommitInfo[],
  via: "push" | "mirror-inbound",
): Promise<void> {
  if (commits.length === 0) return;
  const shas = commits.map((c) => c.sha);
  const existingRows = await db
    .select({ gitSha: changes.gitSha })
    .from(changes)
    .where(and(eq(changes.repoId, repoId), inArray(changes.gitSha, shas)));
  const existing = new Set(existingRows.map((r) => r.gitSha));
  const toRecord = commits.filter((c) => !existing.has(c.sha));
  if (toRecord.length === 0) return;

  // One transaction per batch (not per commit) — a >500-commit mirror import
  // used to do one DB round-trip per commit; this keeps the per-commit
  // signature and operations row (the append-only spine invariant) but pages
  // the round-trips instead.
  await db.transaction(async (tx) => {
    for (const commit of toRecord) {
      const provenance = { kind: actor.kind, principal: actor.principal, via };
      const signature = signer.sign({
        repo: `${owner}/${name}`,
        git_sha: commit.sha,
        intent_id: null,
        provenance,
      });

      const [change] = await tx
        .insert(changes)
        .values({ repoId, gitSha: commit.sha, intentId: null, provenance, signature })
        .returning();

      await recordOperation(tx, {
        repoId,
        actorId: actor.id,
        verb: "change.create",
        target: `${owner}/${name}@${commit.sha}`,
        after: { id: change!.id, gitSha: commit.sha, via },
      });
    }
  });
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
  // everything on every new branch. `existing change` dedup in
  // recordCommitsBatch covers the rest regardless.
  //
  // This shortcut is wrong for one case this function doesn't handle yet: a
  // *first* mirror import, where a branch is pushed as brand-new on the ADP
  // side but carries real, never-before-seen history (there's nothing else
  // it could have forked from that's "already recorded"). Mirror mode's
  // first-import path needs its own bulk-import call that walks full
  // history rather than relying on this heuristic.
  if (oldSha === ZERO_SHA) {
    const commits = await gitBackend.log(owner, name, newSha, 1);
    await recordCommitsBatch(db, signer, repoId, owner, name, actor, commits, via);
    return;
  }

  // Page through the whole range in RECORD_BATCH_SIZE-sized batches — this
  // is what turns a >500-commit mirror import into a complete record
  // instead of a truncated one.
  let skip = 0;
  for (;;) {
    const batch = await gitBackend.log(owner, name, `${oldSha}..${newSha}`, RECORD_BATCH_SIZE, skip);
    if (batch.length === 0) break;
    await recordCommitsBatch(db, signer, repoId, owner, name, actor, batch, via);
    if (batch.length < RECORD_BATCH_SIZE) break;
    skip += RECORD_BATCH_SIZE;
  }
}
