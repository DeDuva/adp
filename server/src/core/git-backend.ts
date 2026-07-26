import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface TreeEntry {
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  path: string;
}

export interface CommitInfo {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  parents: string[];
}

export interface DiffEntry {
  status: "added" | "removed" | "modified" | "renamed";
  path: string;
}

async function run(args: string[], cwd: string): Promise<{ stdout: string; stdoutBuf: Buffer }> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return { stdout: (stdout as Buffer).toString("utf8"), stdoutBuf: stdout as Buffer };
}

// `execFile` has no promise-friendly way to pipe stdin; `spawn` does.
function runWithInput(args: string[], cwd: string, input: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.end(input);
  });
}

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

  // Resolves `ref:path` to its object type ("blob" for a file, "tree" for a
  // directory) and sha — null if the path doesn't exist at that ref.
  async statPath(
    owner: string,
    name: string,
    ref: string,
    filePath: string,
  ): Promise<{ type: "blob" | "tree"; sha: string } | null> {
    const cwd = this.repoPath(owner, name);
    const spec = filePath ? `${ref}:${filePath}` : `${ref}:`;
    try {
      const { stdout: sha } = await run(["rev-parse", "--verify", spec], cwd);
      const { stdout: type } = await run(["cat-file", "-t", sha.trim()], cwd);
      const t = type.trim();
      if (t !== "blob" && t !== "tree") return null;
      return { type: t, sha: sha.trim() };
    } catch {
      return null;
    }
  }

  async readBlob(owner: string, name: string, sha: string): Promise<Buffer> {
    const { stdoutBuf } = await run(["cat-file", "-p", sha], this.repoPath(owner, name));
    return stdoutBuf;
  }

  // Direct children only (GitHub's contents API is non-recursive per directory).
  async listTree(owner: string, name: string, treeSha: string): Promise<TreeEntry[]> {
    const { stdout } = await run(["ls-tree", treeSha], this.repoPath(owner, name));
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [meta, entryPath] = line.split("\t");
        const [mode, type, sha] = meta!.split(" ");
        return { mode: mode!, type: type as TreeEntry["type"], sha: sha!, path: entryPath! };
      });
  }

  async getCommit(owner: string, name: string, sha: string): Promise<CommitInfo | null> {
    try {
      const { stdout } = await run(
        ["show", "-s", "--format=%H%x00%an%x00%ae%x00%aI%x00%P%x00%B", sha],
        this.repoPath(owner, name),
      );
      const [full, authorName, authorEmail, authorDate, parents, ...rest] = stdout.split("\0");
      return {
        sha: full!.trim(),
        authorName: authorName!,
        authorEmail: authorEmail!,
        authorDate: authorDate!,
        parents: parents!.trim() ? parents!.trim().split(" ") : [],
        message: rest.join("\0").replace(/\n+$/, ""),
      };
    } catch {
      return null;
    }
  }

  // Newest-first, matching GitHub's `GET .../commits` ordering.
  async log(owner: string, name: string, ref: string, limit: number): Promise<CommitInfo[]> {
    const { stdout } = await run(
      ["log", `--max-count=${limit}`, "--format=%H%x00%an%x00%ae%x00%aI%x00%P%x00%B%x01", ref],
      this.repoPath(owner, name),
    );
    return stdout
      .split("\x01")
      .filter((entry) => entry.trim())
      .map((entry) => {
        const [full, authorName, authorEmail, authorDate, parents, ...rest] = entry.replace(/^\n/, "").split("\0");
        return {
          sha: full!.trim(),
          authorName: authorName!,
          authorEmail: authorEmail!,
          authorDate: authorDate!,
          parents: parents!.trim() ? parents!.trim().split(" ") : [],
          message: rest.join("\0").replace(/^\n+|\n+$/g, ""),
        };
      });
  }

  async diffNameStatus(owner: string, name: string, base: string, head: string): Promise<DiffEntry[]> {
    const { stdout } = await run(["diff", "--name-status", "-z", `${base}...${head}`], this.repoPath(owner, name));
    const parts = stdout.split("\0").filter(Boolean);
    const entries: DiffEntry[] = [];
    for (let i = 0; i < parts.length; i++) {
      const code = parts[i]!;
      if (code.startsWith("R")) {
        const from = parts[++i]!;
        const to = parts[++i]!;
        entries.push({ status: "renamed", path: to });
        void from;
      } else {
        const filePath = parts[++i]!;
        const status = code === "A" ? "added" : code === "D" ? "removed" : "modified";
        entries.push({ status, path: filePath });
      }
    }
    return entries;
  }

  async diffPatch(owner: string, name: string, base: string, head: string): Promise<string> {
    const { stdout } = await run(["diff", `${base}...${head}`], this.repoPath(owner, name));
    return stdout;
  }

  async mergeBaseCount(owner: string, name: string, from: string, to: string): Promise<number> {
    const { stdout } = await run(["rev-list", "--count", `${from}..${to}`], this.repoPath(owner, name));
    return Number(stdout.trim());
  }

  async listRefs(owner: string, name: string, prefix: string): Promise<{ ref: string; sha: string }[]> {
    const { stdout } = await run(
      ["for-each-ref", "--format=%(refname)%00%(objectname)", prefix],
      this.repoPath(owner, name),
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref, sha] = line.split("\0");
        return { ref: ref!, sha: sha! };
      });
  }

  async createBlob(owner: string, name: string, content: Buffer): Promise<string> {
    const stdout = await runWithInput(["hash-object", "-w", "--stdin"], this.repoPath(owner, name), content);
    return stdout.trim();
  }

  async createTree(
    owner: string,
    name: string,
    entries: { mode: string; type: "blob" | "tree" | "commit"; sha: string; path: string }[],
  ): Promise<string> {
    const input = entries.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.path}`).join("\n") + "\n";
    const stdout = await runWithInput(["mktree"], this.repoPath(owner, name), Buffer.from(input, "utf8"));
    return stdout.trim();
  }

  async createCommit(
    owner: string,
    name: string,
    treeSha: string,
    parents: string[],
    message: string,
    author: { name: string; email: string },
  ): Promise<string> {
    const args = ["commit-tree", treeSha];
    for (const p of parents) args.push("-p", p);
    args.push("-m", message);
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.repoPath(owner, name),
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
      },
    });
    return stdout.trim();
  }

  async createRef(owner: string, name: string, ref: string, sha: string): Promise<void> {
    await run(["update-ref", ref, sha], this.repoPath(owner, name));
  }

  async deleteRef(owner: string, name: string, ref: string): Promise<void> {
    await run(["update-ref", "-d", ref], this.repoPath(owner, name));
  }
}
