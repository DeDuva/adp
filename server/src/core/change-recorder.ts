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
): Promise<number> {
  if (commits.length === 0) return 0;
  const shas = commits.map((c) => c.sha);
  const existingRows = await db
    .select({ gitSha: changes.gitSha })
    .from(changes)
    .where(and(eq(changes.repoId, repoId), inArray(changes.gitSha, shas)));
  const existing = new Set(existingRows.map((r) => r.gitSha));
  const toRecord = commits.filter((c) => !existing.has(c.sha));
  if (toRecord.length === 0) return 0;

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

  return toRecord.length;
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

  // A brand-new ref (oldSha all-zero) has no range to walk, so it walks the
  // full history reachable from the tip and lets dedup decide where to stop:
  // each page is recorded, and the first page that records *nothing* new
  // means every remaining ancestor is already in `changes` too.
  //
  // Both callers need that. An ordinary new local branch forks from history
  // this repo already recorded, so it walks one or two pages and stops —
  // which is what the old "record the tip only" shortcut was protecting. A
  // *first* mirror import is the case that shortcut got wrong: the branch is
  // brand-new on the ADP side but carries real, never-before-seen history,
  // so nothing is deduped and the walk runs to the root. That is M2's exit
  // criterion ("a mirrored repo with a >500-commit history has a signed
  // change recorded for every commit") applied to the import itself rather
  // than only to subsequent pushes.
  //
  // Deliberately not `git log <tip> --not --exclude=<ref> --all` to compute
  // "history no other ref has": `--all` includes HEAD, which in a bare repo
  // resolves to the default branch, so that form returns nothing at all for
  // exactly the first-import case — silently, and looking like success.
  const range = oldSha === ZERO_SHA ? newSha : `${oldSha}..${newSha}`;

  // Page through in RECORD_BATCH_SIZE-sized batches — this is what turns a
  // >500-commit mirror import into a complete record instead of a truncated
  // one.
  let skip = 0;
  for (;;) {
    const batch = await gitBackend.log(owner, name, range, RECORD_BATCH_SIZE, skip);
    if (batch.length === 0) break;
    const recorded = await recordCommitsBatch(db, signer, repoId, owner, name, actor, batch, via);
    if (oldSha === ZERO_SHA && recorded === 0) break;
    if (batch.length < RECORD_BATCH_SIZE) break;
    skip += RECORD_BATCH_SIZE;
  }
}
