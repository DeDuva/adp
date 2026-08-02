import { parseFlags, splitRepo } from "../args.js";
import { apiRequest } from "../api.js";

// Wraps POST /api/v3/repos/:owner/:repo/mirror (docs/pragmatic_mvp.md M2's
// mirror mode) — configures ADP to sit alongside a repo that stays on
// GitHub. `--secret` verifies *inbound* GitHub webhook deliveries; it's
// separate from any repo-level outbound webhook secret. `--credential` is
// the credential ADP uses to push *out* to the remote (a PAT or deploy key) —
// required by the server (http-rest/mirrors.ts's CreateMirrorBody), never
// echoed back. `direction` is `outbound|inbound|both`, matching the server's
// own vocabulary (not GitHub's `push`/`pull` remote naming).
export async function repoMirror(argv: string[]): Promise<void> {
  const [ownerRepo, ...rest] = argv;
  const flags = parseFlags(rest);
  if (!ownerRepo || !flags["remote-url"] || !flags.secret || !flags.credential) {
    throw new Error(
      "usage: adp repo mirror <owner>/<repo> --remote-url <url> --secret <secret> --credential <credential> [--direction outbound|inbound|both]",
    );
  }
  const { owner, repo } = splitRepo(ownerRepo);

  const result = await apiRequest("POST", `/api/v3/repos/${owner}/${repo}/mirror`, {
    remote_url: flags["remote-url"],
    webhook_secret: flags.secret,
    credential: flags.credential,
    direction: flags.direction ?? "both",
  });
  console.log(JSON.stringify(result, null, 2));
}
