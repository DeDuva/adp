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

  async commitExists(owner: string, name: string, gitSha: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync("git", ["cat-file", "-t", gitSha], {
        cwd: this.repoPath(owner, name),
      });
      return stdout.trim() === "commit";
    } catch {
      return false;
    }
  }

  async resolveRef(owner: string, name: string, ref: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", `refs/heads/${ref}`], {
        cwd: this.repoPath(owner, name),
      });
      return stdout.trim();
    } catch {
      return null;
    }
  }

  async isAncestor(owner: string, name: string, ancestorSha: string, descendantSha: string): Promise<boolean> {
    try {
      await execFileAsync("git", ["merge-base", "--is-ancestor", ancestorSha, descendantSha], {
        cwd: this.repoPath(owner, name),
      });
      return true;
    } catch {
      return false;
    }
  }

  // Fast-forward only: sets refs/heads/<branch> to newSha, but only if the
  // ref currently points at expectedCurrentSha (optimistic concurrency) and
  // newSha is a descendant of it. No merge commits, no rebasing — matches
  // the cut list's "conflict = failed merge, agent rebases" MVP conflict
  // model (docs/pragmatic_mvp.md §2.5).
  async fastForwardRef(
    owner: string,
    name: string,
    branch: string,
    expectedCurrentSha: string,
    newSha: string,
  ): Promise<boolean> {
    try {
      await execFileAsync(
        "git",
        ["update-ref", `refs/heads/${branch}`, newSha, expectedCurrentSha],
        { cwd: this.repoPath(owner, name) },
      );
      return true;
    } catch {
      return false;
    }
  }
}
