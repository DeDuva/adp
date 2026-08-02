import { parseFlags, splitRepo } from "../args.js";
import { apiRequest } from "../api.js";

export async function prList(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  if (!flags.repo) {
    throw new Error("usage: adp pr list --repo <owner>/<repo>");
  }
  const { owner, repo } = splitRepo(flags.repo);

  const result = await apiRequest("GET", `/api/v3/repos/${owner}/${repo}/pulls`);
  console.log(JSON.stringify(result, null, 2));
}
