import type { GitBackend } from "./git-backend.js";

export type MergeMethod = "merge" | "squash" | "rebase";

export interface MergeAuthor {
  name: string;
  email: string;
}

export interface MergeTarget {
  owner: string;
  name: string;
  baseRef: string;
  headSha: string;
  headRef: string;
  number: number;
  title: string;
  body: string;
}

export type PerformMergeResult = { ok: true; sha: string } | { ok: false; status: 409 | 422; message: string };

// Land model keeps the FF-precondition-only conflict story (docs/pragmatic_mvp.md
// §2.5, "conflict = failed merge, agent rebases") — callers must already have
// confirmed currentBaseSha is an ancestor of headSha before calling this. What
// merge_method changes is what commit ends up on the base ref afterward: a real
// merge commit or squash commit instead of always reusing headSha verbatim, the
// fidelity gap named in docs/m2-readiness-review.md ("gh pr merge --merge cannot
// be distinguished from GitHub behavior until history is inspected").
export async function performMerge(
  gitBackend: GitBackend,
  target: MergeTarget,
  currentBaseSha: string,
  method: MergeMethod,
  author: MergeAuthor,
): Promise<PerformMergeResult> {
  if (method === "rebase") {
    return { ok: false, status: 422, message: "merge_method 'rebase' is not yet supported" };
  }

  const headTree = await gitBackend.statPath(target.owner, target.name, target.headSha, "");
  if (!headTree) {
    return { ok: false, status: 422, message: `head '${target.headSha}' could not be resolved` };
  }

  const newSha =
    method === "squash"
      ? await gitBackend.createCommit(
          target.owner,
          target.name,
          headTree.sha,
          [currentBaseSha],
          `${target.title} (#${target.number})\n\n${target.body}`,
          author,
        )
      : await gitBackend.createCommit(
          target.owner,
          target.name,
          headTree.sha,
          [currentBaseSha, target.headSha],
          `Merge pull request #${target.number} from ${target.headRef}\n\n${target.title}`,
          author,
        );

  const updated = await gitBackend.fastForwardRef(target.owner, target.name, target.baseRef, currentBaseSha, newSha);
  if (!updated) {
    return { ok: false, status: 409, message: `base '${target.baseRef}' moved concurrently, retry` };
  }
  return { ok: true, sha: newSha };
}
