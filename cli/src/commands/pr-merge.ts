import { parseFlags, splitRepo } from "../args.js";
import { apiRequest } from "../api.js";

export async function prMerge(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  if (!flags.repo || !flags.number) {
    throw new Error("usage: adp pr merge --repo <owner>/<repo> --number <n> [--method merge|squash|rebase]");
  }
  const { owner, repo } = splitRepo(flags.repo);

  const result = await apiRequest("PUT", `/api/v3/repos/${owner}/${repo}/pulls/${flags.number}/merge`, {
    merge_method: flags.method ?? "merge",
  });
  console.log(JSON.stringify(result, null, 2));
}
