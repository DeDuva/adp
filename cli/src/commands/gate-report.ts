import { parseFlags, splitRepo } from "../args.js";
import { apiRequest } from "../api.js";

// Wraps POST /api/v3/repos/:owner/:repo/gates — the same endpoint a
// scanner-as-gate adapter (docs/pragmatic_mvp.md M2) posts a SARIF-derived
// result to, exposed here as a plain CLI command for anything that isn't a
// full adapter (a CI step, a manual report).
export async function gateReport(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  if (!flags.repo || !flags.sha || !flags.name || !flags.status) {
    throw new Error(
      "usage: adp gate report --repo <owner>/<repo> --sha <sha> --name <name> --status <success|failure|pending> [--summary <text>]",
    );
  }
  const { owner, repo } = splitRepo(flags.repo);

  const result = await apiRequest("POST", `/api/v3/repos/${owner}/${repo}/gates`, {
    git_sha: flags.sha,
    name: flags.name,
    status: flags.status,
    summary: flags.summary ?? "",
  });
  console.log(JSON.stringify(result, null, 2));
}
