import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend, CommitInfo } from "./git-backend.js";
import type { Signer } from "./signing.js";
import { changes, intents, issues, sessions } from "../db/schema.js";
import { recordOperation } from "./operations.js";
import {
  asIntentUuid,
  asIssueNumber,
  asSessionUuid,
  noteToken,
  parseCommitTrailers,
  type CommitTrailers,
} from "./commit-trailers.js";

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
  // #229: the agent provenance tuple the token was minted with. Optional
  // because a human PAT carries none of it, and absent-means-absent — a change
  // pushed by a person must not claim a harness.
  //
  // These are on the *actor* rather than passed alongside it because the actor
  // is what a change is attributed to, and #230 made that per commit: a push
  // whose commits have different authors has different provenance per commit,
  // and splitting "who" from "how they were working" would let the two drift
  // apart one caller at a time.
  harness?: string | null;
  model?: string | null;
  sessionId?: string | null;
}

// What a batch's trailers resolved to, keyed by the raw token as written so a
// commit can look up its own without re-parsing.
interface ResolvedTrailers {
  intents: Map<string, string>;
  sessions: Map<string, string>;
}

// Resolve a whole batch's trailers in three queries rather than three per
// commit. A first mirror import walks an entire history in 500-commit pages, so
// a per-commit lookup here is 500 round-trips against a path whose whole job is
// to not be the slow part of a push.
//
// **Everything is scoped to this repo, and nothing here can fail a push.** A
// trailer is written by whoever can push, so it is untrusted input: a token
// that is not shaped like a reference never reaches a query (Postgres rejects a
// malformed uuid with an error, which would surface as a failed push), and one
// that names another repository's intent resolves to nothing. An unresolvable
// trailer leaves the change unbound — never rejected. A push refused over a
// mistyped trailer is a far worse failure than a change that is missing a link.
async function resolveTrailers(db: Db, repoId: string, parsed: CommitTrailers[]): Promise<ResolvedTrailers> {
  const resolved: ResolvedTrailers = { intents: new Map(), sessions: new Map() };

  const intentTokens = new Map<string, string>();
  const issueTokens = new Map<string, number>();
  const sessionTokens = new Map<string, string>();
  for (const trailers of parsed) {
    if (trailers.intent) {
      const uuid = asIntentUuid(trailers.intent);
      if (uuid) intentTokens.set(trailers.intent, uuid);
      else {
        const number = asIssueNumber(trailers.intent);
        if (number !== null) issueTokens.set(trailers.intent, number);
      }
    }
    if (trailers.session) {
      const uuid = asSessionUuid(trailers.session);
      if (uuid) sessionTokens.set(trailers.session, uuid);
    }
  }

  if (intentTokens.size > 0) {
    const rows = await db
      .select({ id: intents.id })
      .from(intents)
      .where(and(eq(intents.repoId, repoId), inArray(intents.id, [...new Set(intentTokens.values())])));
    const known = new Set(rows.map((row) => row.id));
    for (const [token, uuid] of intentTokens) if (known.has(uuid)) resolved.intents.set(token, uuid);
  }

  if (issueTokens.size > 0) {
    const rows = await db
      .select({ number: issues.number, intentId: issues.intentId })
      .from(issues)
      .where(and(eq(issues.repoId, repoId), inArray(issues.number, [...new Set(issueTokens.values())])));
    // An issue filed before intents were minted alongside them has no intent to
    // inherit; that is unresolved, not an error.
    const byNumber = new Map(rows.filter((row) => row.intentId).map((row) => [row.number, row.intentId!]));
    for (const [token, number] of issueTokens) {
      const intentId = byNumber.get(number);
      if (intentId) resolved.intents.set(token, intentId);
    }
  }

  if (sessionTokens.size > 0) {
    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.repoId, repoId), inArray(sessions.id, [...new Set(sessionTokens.values())])));
    const known = new Set(rows.map((row) => row.id));
    for (const [token, uuid] of sessionTokens) if (known.has(uuid)) resolved.sessions.set(token, uuid);
  }

  return resolved;
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
  actorForSha?: Map<string, RecordActor>,
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

  // Read the batch's trailers before opening the transaction: these are lookups
  // against rows this push does not touch, and holding a write transaction open
  // across them buys nothing.
  const trailersBySha = new Map(toRecord.map((c) => [c.sha, parseCommitTrailers(c.message)]));
  const resolved = await resolveTrailers(db, repoId, [...trailersBySha.values()]);

  // One transaction per batch (not per commit) — a >500-commit mirror import
  // used to do one DB round-trip per commit; this keeps the per-commit
  // signature and operations row (the append-only spine invariant) but pages
  // the round-trips instead.
  let recorded = 0;
  await db.transaction(async (tx) => {
    for (const commit of toRecord) {
      const trailers = trailersBySha.get(commit.sha)!;
      // #230: who wrote this commit, when the caller could work that out.
      // Mirror inbound used to attribute every commit to the mirror's own
      // system identity — a statement about how the record arrived, written
      // into the field that says who made the change. The direct push path has
      // one actor for the whole push and passes no map, which is correct there:
      // a push has exactly one pusher.
      const commitActor = actorForSha?.get(commit.sha) ?? actor;
      const intentId = trailers.intent ? (resolved.intents.get(trailers.intent) ?? null) : null;
      const sessionId = trailers.session ? (resolved.sessions.get(trailers.session) ?? null) : null;

      // `session_id` rides in provenance rather than in a column of its own,
      // which is where the explicit change route already puts the one it reads
      // off the token — so both paths produce the same shape, and the signature
      // covers it either way.
      //
      // #229: and so do `harness` and `model`, which is the whole of that
      // defect. `AuthenticatedIdentity` has carried all three since 1-1, the
      // explicit REST route has always written all three, and the push path —
      // the one 1b exists to make *ambient*, and therefore the only one an
      // agent actually takes — wrote none of them. The failure was silent: the
      // provenance block was present, signed, and merely thinner, which no
      // check could distinguish from a human pushing without a harness.
      //
      // The trailer wins over the token for `session_id` because it is the more
      // specific claim: the token says which session did the *push*, and the
      // trailer says which session produced *this commit*. They differ whenever
      // one push carries work from more than one session, which is the ordinary
      // shape of a branch that took two sittings.
      const provenance = {
        kind: commitActor.kind,
        principal: commitActor.principal,
        via,
        ...(commitActor.harness ? { harness: commitActor.harness } : {}),
        ...(commitActor.model ? { model: commitActor.model } : {}),
        ...(sessionId ?? commitActor.sessionId ? { session_id: sessionId ?? commitActor.sessionId } : {}),
      };
      const signature = signer.sign({
        repo: `${owner}/${name}`,
        git_sha: commit.sha,
        intent_id: intentId,
        provenance,
      });

      // The pre-flight `existing` check above is the ordinary dedup; this is
      // the race it cannot close. Two pushes carrying the same commit can both
      // read "not recorded" and both insert, and since #143 made
      // (repo_id, git_sha) unique the loser would raise — inside one
      // transaction covering the whole batch, so a duplicate on *one* commit
      // would discard the records for every other commit pushed with it. The
      // constraint picks the winner; the loser records nothing and says so by
      // returning no row, which is the right outcome either way.
      const [change] = await tx
        .insert(changes)
        .values({ repoId, gitSha: commit.sha, intentId, provenance, signature })
        .onConflictDoNothing({ target: [changes.repoId, changes.gitSha] })
        .returning();
      if (!change) continue;

      await recordOperation(tx, {
        repoId,
        actorId: commitActor.id,
        verb: "change.create",
        target: `${owner}/${name}@${commit.sha}`,
        after: {
          id: change.id,
          gitSha: commit.sha,
          via,
          intentId,
          // A trailer that named something this repo does not have is worth
          // finding later — a typo'd UUID looks identical to no trailer at all
          // in the change record, and the difference is the whole point.
          ...(trailers.intent && !intentId ? { unresolvedIntentTrailer: noteToken(trailers.intent) } : {}),
        },
      });
      recorded += 1;
    }
  });

  // What was actually written, not what was planned — the caller uses a zero
  // here to decide it has walked back into already-recorded history and can
  // stop paging.
  return recorded;
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
  // #230: per-commit attribution, where the caller has it. The inbound mirror
  // builds this from the push payload's `commits[].author.username`; a commit
  // the payload does not name (GitHub caps that array at 20, and a first import
  // walks history nothing ever delivered) falls back to `actor`, which is the
  // mirror's system identity and remains the honest answer for a commit whose
  // author this instance has no way to know.
  actorForSha?: Map<string, RecordActor>,
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
    const recorded = await recordCommitsBatch(db, signer, repoId, owner, name, actor, batch, via, actorForSha);
    if (oldSha === ZERO_SHA && recorded === 0) break;
    if (batch.length < RECORD_BATCH_SIZE) break;
    skip += RECORD_BATCH_SIZE;
  }
}
