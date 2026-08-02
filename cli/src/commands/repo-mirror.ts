import { parseFlags, splitRepo } from "../args.js";
import { apiRequest } from "../api.js";

// Wraps POST /api/v3/repos/:owner/:repo/mirror (docs/pragmatic_mvp.md M2's
// mirror mode) — configures ADP to sit alongside a repo that stays on
// GitHub. `--secret` verifies *inbound* GitHub webhook deliveries; it's
// separate from any repo-level outbound webhook secret.
export async function repoMirror(argv: string[]): Promise<void> {
  const [ownerRepo, ...rest] = argv;
  const flags = parseFlags(rest);
  if (!ownerRepo || !flags["remote-url"] || !flags.secret) {
    throw new Error(
      "usage: adp repo mirror <owner>/<repo> --remote-url <url> --secret <secret> [--direction push|pull|both]",
    );
  }
  const { owner, repo } = splitRepo(ownerRepo);

  const result = await apiRequest("POST", `/api/v3/repos/${owner}/${repo}/mirror`, {
    remote_url: flags["remote-url"],
    webhook_secret: flags.secret,
    direction: flags.direction ?? "both",
  });
  console.log(JSON.stringify(result, null, 2));
}
