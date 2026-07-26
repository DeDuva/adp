import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

// All git plumbing goes through the real `git` binary as a subprocess: 100%
// wire-protocol fidelity for free, no isomorphic-git edge cases.
export class GitBackend {
  constructor(private readonly gitRoot: string) {}

  repoPath(owner: string, name: string): string {
    return path.join(this.gitRoot, owner, `${name}.git`);
  }

  async initBareRepo(owner: string, name: string, defaultBranch: string): Promise<void> {
    const repoPath = this.repoPath(owner, name);
    await mkdir(path.dirname(repoPath), { recursive: true });
    await execFileAsync("git", [
      "init",
      "--bare",
      "--initial-branch",
      defaultBranch,
      repoPath,
    ]);
    // Smart-HTTP push is opt-in per repo; the compat plane needs it on by default.
    await execFileAsync("git", ["config", "http.receivepack", "true"], { cwd: repoPath });
  }

  async exists(owner: string, name: string): Promise<boolean> {
    try {
      await execFileAsync("git", ["rev-parse", "--is-bare-repository"], {
        cwd: this.repoPath(owner, name),
      });
      return true;
    } catch {
      return false;
    }
  }
}
