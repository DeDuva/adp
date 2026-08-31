import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { excludePaths, hooksDir, installHook, removeHook, remoteRepo, repoRoot, unexcludePaths } from "../src/git.js";

function run(dir: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } }).trim();
}

describe("what connect reads off the checkout", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "adp-connect-git-"));
    run(dir, ["init", "-q", "-b", "main"]);
    run(dir, ["config", "user.email", "t@example.com"]);
    run(dir, ["config", "user.name", "T"]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds the remote that points at this server, not merely the first one", () => {
    // A checkout can have several remotes and only one of them is the forge
    // being connected. Guessing from `origin` would cheerfully connect a
    // GitHub clone to an ADP instance and report success.
    run(dir, ["remote", "add", "origin", "https://github.com/acme/widget.git"]);
    run(dir, ["remote", "add", "adp", "https://adp.example.com/acme/widget.git"]);
    expect(remoteRepo(dir, "https://adp.example.com")).toEqual({ owner: "acme", repo: "widget" });
  });

  it("sees through a token embedded in the remote URL", () => {
    // A token as the git password is how this repository documents cloning,
    // so the host comparison has to survive one.
    run(dir, ["remote", "add", "origin", "https://x-access-token:secret@adp.example.com/acme/widget.git"]);
    expect(remoteRepo(dir, "https://adp.example.com")).toEqual({ owner: "acme", repo: "widget" });
  });

  it("answers null when no remote points at the server", () => {
    run(dir, ["remote", "add", "origin", "https://github.com/acme/widget.git"]);
    expect(remoteRepo(dir, "https://adp.example.com")).toBeNull();
  });

  it("knows the repository root and where its hooks go, from a subdirectory", () => {
    // Connect is run from wherever the developer happens to be, and it writes
    // into the repository root rather than into that directory.
    const nested = path.join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(repoRoot(nested)).toBe(run(dir, ["rev-parse", "--show-toplevel"]));
    // `--git-path hooks` rather than a hard-coded `.git/hooks`, so a worktree
    // gets its own answer instead of the main checkout's.
    expect(hooksDir(nested)!.endsWith(path.join(".git", "hooks"))).toBe(true);
  });

  it("answers null outside a repository", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "adp-connect-nogit-"));
    expect(repoRoot(outside)).toBeNull();
    expect(hooksDir(outside)).toBeNull();
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("the prepare-commit-msg hook, against real commits", () => {
  let dir: string;

  function commit(message: string, extra: string[] = []): string {
    writeFileSync(path.join(dir, `f-${Math.random()}.txt`), "x");
    run(dir, ["add", "-A"]);
    run(dir, ["commit", "-q", "-m", message, ...extra]);
    return run(dir, ["log", "-1", "--format=%B"]);
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "adp-connect-hook-"));
    run(dir, ["init", "-q", "-b", "main"]);
    run(dir, ["config", "user.email", "t@example.com"]);
    run(dir, ["config", "user.name", "T"]);
    installHook(hooksDir(dir)!);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the trailer from a branch named for its issue", () => {
    // The client half #142 never had: the server has read this trailer since
    // #142 and writing one stayed something a person had to remember.
    run(dir, ["checkout", "-q", "-b", "fix/151-session-lifecycle"]);
    expect(commit("Do the work")).toContain("ADP-Intent: #151");
  });

  it("prefers an intent set on the branch over the branch's own name", () => {
    run(dir, ["checkout", "-q", "-b", "fix/151-something"]);
    run(dir, ["config", "branch.fix/151-something.adpIntent", "11111111-2222-3333-4444-555555555555"]);
    expect(commit("Do the work")).toContain("ADP-Intent: 11111111-2222-3333-4444-555555555555");
  });

  it("writes nothing on a branch that names no issue", () => {
    // A wrong intent binds the change to work it did not do, which is worse
    // than no binding and much harder to notice.
    run(dir, ["checkout", "-q", "-b", "docs/readme-quickstart"]);
    expect(commit("Do the work")).not.toContain("ADP-Intent");
  });

  it("never overwrites a trailer the author wrote", () => {
    run(dir, ["checkout", "-q", "-b", "fix/151-x"]);
    const message = commit("Do the work\n\nADP-Intent: #99\n");
    expect(message).toContain("ADP-Intent: #99");
    expect(message).not.toContain("#151");
  });

  it("keeps out of a merge commit's message", () => {
    // A trailer appended to a message git assembled binds a change to an
    // intent nobody chose.
    commit("base");
    run(dir, ["checkout", "-q", "-b", "side"]);
    commit("on the side");
    run(dir, ["checkout", "-q", "main"]);
    commit("on main");
    run(dir, ["checkout", "-q", "-b", "fix/151-merge"]);
    run(dir, ["merge", "--no-ff", "-q", "-m", "Merge side", "side"]);
    expect(run(dir, ["log", "-1", "--format=%B"])).not.toContain("ADP-Intent");
  });

  it("puts the trailer in the trailer block, not inside a paragraph", () => {
    run(dir, ["checkout", "-q", "-b", "feat/42-thing"]);
    const message = commit("Subject\n\nA body paragraph explaining things.\n");
    const lines = message.trim().split("\n");
    expect(lines[lines.length - 1]).toBe("ADP-Intent: #42");
  });
});

describe("installing and removing the hook", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "adp-connect-hookfile-"));
    run(dir, ["init", "-q", "-b", "main"]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reports an installation and then an update, rather than duplicating", () => {
    expect(installHook(hooksDir(dir)!).outcome).toBe("installed");
    expect(installHook(hooksDir(dir)!).outcome).toBe("updated");
  });

  it("leaves a hook ADP did not write, and does not remove it either", () => {
    // Refusing costs a manual step. The alternative costs a hook nobody kept
    // a copy of.
    const file = path.join(hooksDir(dir)!, "prepare-commit-msg");
    writeFileSync(file, "#!/bin/sh\necho mine\n", { mode: 0o755 });
    expect(installHook(hooksDir(dir)!).outcome).toBe("foreign");
    expect(readFileSync(file, "utf8")).toContain("echo mine");
    expect(removeHook(hooksDir(dir)!).removed).toBe(false);
    expect(readFileSync(file, "utf8")).toContain("echo mine");
  });

  it("removes its own", () => {
    installHook(hooksDir(dir)!);
    expect(removeHook(hooksDir(dir)!).removed).toBe(true);
    expect(removeHook(hooksDir(dir)!).removed).toBe(false);
  });
});

describe("keeping the credential out of commits", () => {
  let dir: string;
  const exclude = () => readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8");

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "adp-connect-exclude-"));
    run(dir, ["init", "-q", "-b", "main"]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("excludes the files connect writes a token into", () => {
    expect(excludePaths(dir, ["/.mcp.json", "/.adp/"])).toBe(true);
    writeFileSync(path.join(dir, ".mcp.json"), "{}");
    expect(run(dir, ["status", "--porcelain", "--untracked-files=all"])).not.toContain(".mcp.json");
  });

  it("merges rather than duplicating, across two harnesses", () => {
    excludePaths(dir, ["/.mcp.json", "/.adp/"]);
    excludePaths(dir, ["/.codex/config.toml", "/.adp/"]);
    const body = exclude();
    expect(body.match(/\/\.adp\//g)).toHaveLength(1);
    expect(body).toContain("/.mcp.json");
    expect(body).toContain("/.codex/config.toml");
  });

  it("keeps whatever else was in the file, and takes back only its own", () => {
    const file = path.join(dir, ".git", "info", "exclude");
    writeFileSync(file, "# my own ignores\n*.tmp\n");
    excludePaths(dir, ["/.mcp.json"]);
    unexcludePaths(dir, ["/.mcp.json"]);
    expect(exclude()).toContain("*.tmp");
    expect(exclude()).not.toContain(".mcp.json");
  });

  it("reports when there was nothing of its own to take back", () => {
    expect(unexcludePaths(dir, ["/.mcp.json"])).toBe(false);
  });
});
