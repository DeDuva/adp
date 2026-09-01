import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "./git-backend.js";
import { operations, proposals } from "../db/schema.js";
import { recordOperation } from "./operations.js";
import { enqueueGateJob } from "./gate-jobs.js";
import { loadRepoPolicy } from "./repo-policy.js";

export type ProposalRow = typeof proposals.$inferSelect;

// Which of the two paths an undo took. They are different facts about history
// and the log does not blur them (#159): a rollback means the change was never
// in the branch a reader is looking at, and a revert means it was there and a
// second change took it back out. Anyone reconstructing what happened needs to
// be able to tell those apart, and neither is a degraded version of the other.
export type UndoPath = "rollback" | "revert";

export interface UndoRollback {
  ok: true;
  path: "rollback";
  operationId: string;
}

export interface UndoRevert {
  ok: true;
  path: "revert";
  operationId: string;
  // The revert is a *proposal*, not a merge. It goes through the land policy
  // like every other change, so undo stops at "here is the change that undoes
  // it" rather than at "it is undone".
  proposal: ProposalRow;
  revertSha: string;
  branch: string;
  gateJobs: number;
}

export interface UndoRefusal {
  ok: false;
  message: string;
  // Set only when a compensating revert could not be produced because the
  // change has been built on since. Named paths rather than a count: "it
  // conflicts" is not actionable, "it conflicts in server/src/core/land.ts" is.
  conflicts?: string[];
}

export type UndoResult = UndoRollback | UndoRevert | UndoRefusal;

// Undo, with the two paths it actually has.
//
// **Rollback** winds the base ref back with the same compare-and-swap the merge
// used, and is only available while the ref still points where the merge left
// it. That precondition is not a limitation to be worked around — it is what
// makes rollback exact. Nothing else landed, so nothing else is lost.
//
// **A compensating revert** is what happens when it has. Until #159 the moved
// branch produced a refusal and nothing else, which meant undo worked right up
// until somebody else pushed — minutes, on any active repository. Now the
// second path produces the change that takes the merge back out, on top of
// whatever landed since.
//
// Two decisions worth stating here rather than leaving to be discovered:
//
//   - **The revert goes through the land policy.** A revert is a change, and an
//     undo that bypasses the gate is a hole in the gate — the same hole, opened
//     by the one verb most likely to be used in a hurry. So this produces a
//     proposal and stops. It also enqueues that proposal's gates, because a
//     proposal the policy can never be satisfied for is a refusal wearing a
//     different shape.
//
//   - **A conflicting revert is refused, with the conflict named.** Producing a
//     tree with conflict markers in it would be a second outage caused by
//     fixing the first.
//
// Other verbs are still not undoable, and still say so rather than no-opping.
export async function undoOperation(
  db: Db,
  gitBackend: GitBackend,
  repo: { id: string; owner: string; name: string },
  entry: typeof operations.$inferSelect,
  actorId: string,
): Promise<UndoResult> {
  if (entry.verb !== "proposal.merge") {
    return { ok: false, message: `verb '${entry.verb}' is not undoable` };
  }

  const alreadyUndone = await db.select().from(operations).where(eq(operations.parentOp, entry.id));
  if (alreadyUndone.length > 0) {
    return { ok: false, message: "this merge has already been undone" };
  }

  const after = entry.after as { baseSha: string; mergedInto: string } | null;
  const before = entry.before as { baseSha: string } | null;
  if (!after?.baseSha || !after.mergedInto || !before?.baseSha) {
    return { ok: false, message: "operation is missing the before/after state needed to undo it" };
  }

  const numberMatch = /#(\d+)$/.exec(entry.target);
  const number = numberMatch ? Number(numberMatch[1]) : null;
  const [proposal] = number
    ? await db.select().from(proposals).where(and(eq(proposals.repoId, repo.id), eq(proposals.number, number)))
    : [];
  if (!proposal || proposal.state !== "merged") {
    return { ok: false, message: "the merged proposal this operation refers to can't be found" };
  }

  // fastForwardRef is just an atomic compare-and-swap (git update-ref old
  // new) — nothing about it actually requires moving forward; reused here
  // to move the ref *back*, guarded the same way: only if it still points
  // where the merge left it.
  const rolledBack = await gitBackend.fastForwardRef(
    repo.owner,
    repo.name,
    after.mergedInto,
    after.baseSha,
    before.baseSha,
  );
  if (rolledBack) {
    const operationId = await db.transaction(async (tx) => {
      await tx.update(proposals).set({ state: "open", mergedAt: null }).where(eq(proposals.id, proposal.id));

      const op = await recordOperation(tx, {
        repoId: repo.id,
        actorId,
        verb: "proposal.merge.undo",
        target: entry.target,
        before: { baseSha: after.baseSha },
        after: { baseSha: before.baseSha, path: "rollback" satisfies UndoPath },
        parentOp: entry.id,
      });
      return op.id;
    });
    return { ok: true, path: "rollback", operationId };
  }

  return revertMerge(db, gitBackend, repo, entry, proposal, { after, before }, actorId);
}

// The second path. Reached only when the compare-and-swap above declined,
// which is the same thing as "someone has built on this since".
async function revertMerge(
  db: Db,
  gitBackend: GitBackend,
  repo: { id: string; owner: string; name: string },
  entry: typeof operations.$inferSelect,
  proposal: ProposalRow,
  merge: { after: { baseSha: string; mergedInto: string }; before: { baseSha: string } },
  actorId: string,
): Promise<UndoResult> {
  const { owner, name } = repo;
  const baseRef = merge.after.mergedInto;

  const currentSha = await gitBackend.resolveRef(owner, name, baseRef);
  if (!currentSha) {
    return { ok: false, message: `'${baseRef}' no longer exists, so there is nothing to revert on top of` };
  }

  // The merge has to still be in the branch's history. If it is not, the ref
  // was force-moved or rebased and the change is already gone — reverting it
  // again would remove something a second time, or nothing at all, and either
  // is worse than saying so.
  const stillPresent = await gitBackend.isAncestor(owner, name, merge.after.baseSha, currentSha);
  if (!stillPresent) {
    return {
      ok: false,
      message:
        `'${baseRef}' no longer contains the merge this operation recorded — ` +
        "its history was rewritten, so there is nothing here to revert",
    };
  }

  const reverted = await gitBackend.revertTree(
    owner,
    name,
    currentSha,
    merge.after.baseSha,
    merge.before.baseSha,
  );
  if (!reverted.ok) {
    return {
      ok: false,
      message:
        `reverting #${proposal.number} conflicts with what landed after it — ` +
        "resolve it as an ordinary change rather than as an undo",
      conflicts: reverted.conflicts,
    };
  }

  const title = `Revert "${proposal.title}" (#${proposal.number})`;
  const body =
    `This reverts the merge of #${proposal.number} into \`${baseRef}\`.\n\n` +
    `\`${baseRef}\` moved after that merge, so winding the ref back would have discarded ` +
    "what landed since. This change takes the merge back out on top of it instead.\n\n" +
    `Undoes operation ${entry.id}.`;

  // A revert that produces the tree it started from is a revert of something
  // that is no longer there — the change was already taken out by hand. Checked
  // before the commit exists rather than after: an empty proposal cannot be
  // reviewed for anything, and a dangling commit object is litter.
  const currentTree = await gitBackend.statPath(owner, name, currentSha, "");
  if (currentTree?.sha === reverted.tree) {
    return { ok: false, message: `#${proposal.number} has already been reverted in '${baseRef}'` };
  }

  const revertSha = await gitBackend.createCommit(
    owner,
    name,
    reverted.tree,
    [currentSha],
    `${title}\n\n${body}`,
    { name: "adp", email: "undo@adp.local" },
  );

  const branch = await freeBranchName(gitBackend, owner, name, `adp/revert-${proposal.number}`);
  await gitBackend.createRef(owner, name, `refs/heads/${branch}`, revertSha);

  const created = await db.transaction(async (tx) => {
    // Same repo-row lock the proposal-create route uses, for the same reason:
    // `number` is a read-modify-write and two of these at once would collide on
    // the unique index.
    await tx.execute(sql`select id from repos where id = ${repo.id} for update`);
    const [next] = await tx
      .select({ nextNumber: sql<number>`coalesce(max(${proposals.number}), 0) + 1` })
      .from(proposals)
      .where(eq(proposals.repoId, repo.id));

    const [row] = await tx
      .insert(proposals)
      .values({
        repoId: repo.id,
        number: next!.nextNumber,
        title,
        body,
        headRef: branch,
        headSha: revertSha,
        baseRef,
        authorId: actorId,
      })
      .returning();

    // Recorded as a `proposal.create` as well as the undo below, because it is
    // one: a reader of the proposal's own history should not have to know that
    // this particular proposal came into being through undo to find where it
    // came from.
    await recordOperation(tx, {
      repoId: repo.id,
      actorId,
      verb: "proposal.create",
      target: `${owner}/${name}#${row!.number}`,
      after: { id: row!.id, head: branch, base: baseRef, headSha: revertSha, candidateSetId: null },
    });

    const undoOp = await recordOperation(tx, {
      repoId: repo.id,
      actorId,
      verb: "proposal.merge.revert",
      target: entry.target,
      before: { baseSha: merge.after.baseSha },
      after: {
        path: "revert" satisfies UndoPath,
        revertSha,
        branch,
        proposalNumber: row!.number,
        // Deliberately *not* a baseSha: nothing moved. Recording one would make
        // this read like a rollback in a log query that only looks at `after`.
        baseRef,
      },
      parentOp: entry.id,
    });

    return { proposal: row!, operationId: undoOp.id };
  });

  // The gates the revert has to satisfy, enqueued the way a push would enqueue
  // them. Without this the revert proposal is a change nothing will ever report
  // a gate result for, which under the default `gates_green` floor is a
  // proposal that can never land — a refusal wearing the shape of a fix.
  const gateJobs = await enqueueRevertGates(db, gitBackend, repo, revertSha, actorId);

  return {
    ok: true,
    path: "revert",
    operationId: created.operationId,
    proposal: created.proposal,
    revertSha,
    branch,
    gateJobs,
  };
}

// `adp/revert-7`, or `adp/revert-7-2` if the first is taken. A merge is undoable
// once, so a collision means a previous revert branch was left behind — worth
// stepping around rather than failing on, and worth not silently overwriting.
async function freeBranchName(
  gitBackend: GitBackend,
  owner: string,
  name: string,
  preferred: string,
): Promise<string> {
  if (!(await gitBackend.resolveRef(owner, name, preferred))) return preferred;
  for (let n = 2; n < 100; n++) {
    const candidate = `${preferred}-${n}`;
    if (!(await gitBackend.resolveRef(owner, name, candidate))) return candidate;
  }
  throw new Error(`could not find a free branch name for '${preferred}'`);
}

// Reads `runner.gates` off the *revert* commit, exactly as the push path reads
// it off the pushed sha (http-git/hooks.ts): the gates a change must satisfy
// are the ones its own tree names.
//
// Failing to enqueue is logged into neither — it throws, and the caller is the
// route. That is deliberate: this runs after the proposal is committed, and a
// revert proposal with no gate jobs is a proposal that cannot land. Better to
// surface it than to return success for a change nothing will ever score.
async function enqueueRevertGates(
  db: Db,
  gitBackend: GitBackend,
  repo: { id: string; owner: string; name: string },
  revertSha: string,
  actorId: string,
): Promise<number> {
  const policy = await loadRepoPolicy(gitBackend, repo.owner, repo.name, revertSha);
  if (!policy.runner) return 0;
  for (const gate of policy.runner.gates) {
    await enqueueGateJob(db, {
      repoId: repo.id,
      owner: repo.owner,
      repoName: repo.name,
      gitSha: revertSha,
      name: gate.name,
      image: policy.runner.image,
      command: policy.runner.setup ? `${policy.runner.setup} && ${gate.run}` : gate.run,
      timeoutMs: gate.timeout_ms,
      actorId,
    });
  }
  return policy.runner.gates.length;
}
