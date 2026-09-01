import { parseFlags, splitRepo } from "../args.js";
import { apiRequest } from "../api.js";

const STATES = ["approved", "changes_requested", "commented"] as const;

// #155's done-when is that the canonical walkthrough contains no `curl`, and
// this is the third of the three calls that kept it there. Not one of the four
// commands the issue names, and one line of REST — but leaving it out would
// have meant the walkthrough still reached for `curl` for one step, which is
// the whole thing being fixed.
//
// A review is also where #121 is felt: an approval by the author does not
// satisfy `one_approval`, so this prints what the server recorded rather than
// claiming the requirement is met.
export async function prReview(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  if (!flags.repo || !flags.number || !flags.state) {
    throw new Error(
      `usage: adp pr review --repo <owner>/<repo> --number <n> --state <${STATES.join("|")}> [--body <text>]`,
    );
  }
  if (!(STATES as readonly string[]).includes(flags.state)) {
    throw new Error(`--state must be one of ${STATES.join(", ")}, got '${flags.state}'`);
  }
  const { owner, repo } = splitRepo(flags.repo);

  const review = await apiRequest<{ id: string; state: string }>(
    "POST",
    `/api/v3/repos/${owner}/${repo}/pulls/${flags.number}/reviews`,
    { state: flags.state, body: flags.body ?? "" },
  );
  console.log(`recorded ${review.state} on #${flags.number}`);
  if (flags.state === "approved") {
    // Recorded is not the same as satisfying, and #121 is the reason: an
    // approval by the author is a real review that does not count toward
    // `one_approval`. Saying which is which here saves a confusing refusal
    // later.
    console.log(`  adp watch --repo ${owner}/${repo} --pr ${flags.number}  # whether it satisfies the land policy`);
  }
}
