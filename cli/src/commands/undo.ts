import { parseFlags, splitRepo } from "../args.js";
import { apiRequest, ApiError } from "../api.js";

interface Operation {
  id: string;
  verb: string;
  target: string;
  before: unknown;
  after: unknown;
  created_at: string;
}

interface UndoResult {
  id: string;
  verb: string;
  undo_path: "rollback" | "revert";
  proposal?: { number: number; title: string; head_ref: string; head_sha: string; base_ref: string; state: string };
  gate_jobs_enqueued?: number;
}

interface UndoRefusal {
  message: string;
  conflicts?: string[];
}

// #155. Undo was reachable over REST and from one button in the web UI, and
// nowhere else — so the documented way to undo a merge from a terminal was
// `curl` against an endpoint keyed by an *operation id* nobody has in front of
// them. What a person has is the commit.
//
// So this takes a sha and does the lookup: a `proposal.merge` operation records
// the commit it produced as `after.baseSha`, which is exactly the sha `git log`
// shows on the branch.
export async function undo(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const sha = argv.find((a) => !a.startsWith("--") && /^[0-9a-f]{7,40}$/.test(a));
  if (!flags.repo || !sha) {
    throw new Error("usage: adp undo <sha> --repo <owner>/<repo>");
  }
  const { owner, repo } = splitRepo(flags.repo);

  const merges = await apiRequest<Operation[]>(
    "GET",
    `/api/adp/repos/${owner}/${repo}/operations?verb=proposal.merge&limit=200`,
  );
  const match = merges.find((op) => {
    const after = op.after as { baseSha?: string } | null;
    return typeof after?.baseSha === "string" && after.baseSha.startsWith(sha);
  });
  if (!match) {
    // Naming what was searched, because "not found" for a sha that plainly
    // exists in `git log` is the least actionable message this command could
    // produce. A commit that landed by push rather than by merge is the
    // ordinary reason, and undo covers merges only.
    throw new Error(
      `no merge in ${owner}/${repo} produced ${sha}. ` +
        "Only a landed merge is undoable — a commit pushed directly has no merge operation to undo.",
    );
  }

  try {
    const result = await apiRequest<UndoResult>(
      "POST",
      `/api/adp/repos/${owner}/${repo}/operations/${match.id}/undo`,
      {},
    );
    report(owner, repo, result);
  } catch (err) {
    // #159: a compensating revert that conflicts refuses with the conflicting
    // paths named, and a caller printing only `message` would drop them. The
    // whole reason the server returns them is that "it conflicts" is not
    // actionable and "it conflicts in shared.txt" is.
    const conflicts = err instanceof ApiError ? (err.body as UndoRefusal | undefined)?.conflicts : undefined;
    if (conflicts && conflicts.length > 0) {
      console.error(`adp: ${(err as Error).message}`);
      for (const path of conflicts) console.error(`  conflict: ${path}`);
      throw new Error("resolve the conflict as an ordinary change rather than as an undo");
    }
    throw err;
  }
}

// #159's third done-when: surface both paths and say which one it took. These
// are different facts about history — one means the change is already out of
// the branch, the other means here is the change that takes it out — and a
// caller that printed "undone" for both would be wrong half the time.
function report(owner: string, repo: string, result: UndoResult): void {
  if (result.undo_path === "rollback") {
    console.log(`rolled back — the branch is back where it was, and the proposal is open again.`);
    console.log(`operation ${result.id} (${result.verb})`);
    return;
  }

  const proposal = result.proposal!;
  console.log(`the branch had moved, so winding it back would have discarded what landed since.`);
  console.log(`opened #${proposal.number} on ${proposal.head_ref} — the change that undoes it.`);
  console.log("");
  console.log(`  ${proposal.title}`);
  console.log(`  ${proposal.head_sha.slice(0, 10)} → ${proposal.base_ref}`);
  if (result.gate_jobs_enqueued) {
    console.log(`  ${result.gate_jobs_enqueued} gate(s) enqueued against it`);
  }
  console.log("");
  // The sentence that stops this being read as "done". A revert is a change,
  // and it goes through the same land policy as every other change.
  console.log(`Nothing is undone yet: #${proposal.number} has to satisfy the land policy first.`);
  console.log(`  adp watch --repo ${owner}/${repo} --pr ${proposal.number}`);
  console.log(`  adp pr merge --repo ${owner}/${repo} --number ${proposal.number}`);
}
