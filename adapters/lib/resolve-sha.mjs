import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// A CI step usually already knows its own commit sha, but asking `git`
// directly is one less thing a caller has to wire up when it doesn't.
export async function resolveShaOrHead(sha) {
  if (sha) return sha;
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"]);
  return stdout.trim();
}
