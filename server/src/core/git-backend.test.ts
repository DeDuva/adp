import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitBackend } from "./git-backend.js";

const execFileAsync = promisify(execFile);

// Exercises the real `git` binary against a scratch directory. No Postgres
// required — this is the piece that must never break (docs/pragmatic_mvp.md
// Part 5, "git fidelity suite").
describe("GitBackend", () => {
  let gitRoot: string;
  let backend: GitBackend;

  beforeEach(async () => {
    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-git-backend-test-"));
    backend = new GitBackend(gitRoot);
  });

  afterEach(async () => {
    await rm(gitRoot, { recursive: true, force: true });
  });

  it("reports a repo as absent before init", async () => {
    expect(await backend.exists("acme", "hello")).toBe(false);
  });

  it("initializes a bare repo that is then reported present", async () => {
    await backend.initBareRepo("acme", "hello", "main");
    expect(await backend.exists("acme", "hello")).toBe(true);
  });

  it("places the repo at <root>/<owner>/<name>.git", async () => {
    await backend.initBareRepo("acme", "hello", "main");
    expect(backend.repoPath("acme", "hello")).toBe(path.join(gitRoot, "acme", "hello.git"));
  });

  it("enables http.receivepack so smart-HTTP push works", async () => {
    await backend.initBareRepo("acme", "hello", "main");
    const { stdout } = await execFileAsync("git", ["config", "http.receivepack"], {
      cwd: backend.repoPath("acme", "hello"),
    });
    expect(stdout.trim()).toBe("true");
  });

  describe("with commit history", () => {
    let cloneDir: string;
    let baseSha: string;
    let aheadSha: string;

    // Builds: main (base) -- one commit --> feature (ahead), so isAncestor
    // and fastForwardRef have a real fast-forward to exercise.
    beforeEach(async () => {
      await backend.initBareRepo("acme", "hello", "main");
      cloneDir = await mkdtemp(path.join(tmpdir(), "adp-git-backend-clone-"));
      const repoUrl = backend.repoPath("acme", "hello");

      await execFileAsync("git", ["clone", repoUrl, cloneDir]);
      await execFileAsync("git", ["checkout", "-B", "main"], { cwd: cloneDir });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
      await execFileAsync("sh", ["-c", "echo one > file.txt"], { cwd: cloneDir });
      await execFileAsync("git", ["add", "."], { cwd: cloneDir });
      await execFileAsync("git", ["commit", "-m", "base"], { cwd: cloneDir });
      await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
      baseSha = (await execFileAsync("git", ["rev-parse", "main"], { cwd: cloneDir })).stdout.trim();

      await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: cloneDir });
      await execFileAsync("sh", ["-c", "echo two >> file.txt"], { cwd: cloneDir });
      await execFileAsync("git", ["commit", "-am", "ahead"], { cwd: cloneDir });
      await execFileAsync("git", ["push", "origin", "feature"], { cwd: cloneDir });
      aheadSha = (await execFileAsync("git", ["rev-parse", "feature"], { cwd: cloneDir })).stdout.trim();
    });

    afterEach(async () => {
      await rm(cloneDir, { recursive: true, force: true });
    });

    it("resolveRef returns the commit sha for an existing branch", async () => {
      expect(await backend.resolveRef("acme", "hello", "main")).toBe(baseSha);
    });

    it("resolveRef returns null for a branch that doesn't exist", async () => {
      expect(await backend.resolveRef("acme", "hello", "nope")).toBeNull();
    });

    it("isAncestor is true when base is an ancestor of feature", async () => {
      expect(await backend.isAncestor("acme", "hello", baseSha, aheadSha)).toBe(true);
    });

    it("isAncestor is false when shas are unrelated in that direction", async () => {
      expect(await backend.isAncestor("acme", "hello", aheadSha, baseSha)).toBe(false);
    });

    it("fastForwardRef moves main to feature's sha when base matches expected", async () => {
      const ok = await backend.fastForwardRef("acme", "hello", "main", baseSha, aheadSha);
      expect(ok).toBe(true);
      expect(await backend.resolveRef("acme", "hello", "main")).toBe(aheadSha);
    });

    it("fastForwardRef fails when expectedCurrentSha is stale", async () => {
      const ok = await backend.fastForwardRef("acme", "hello", "main", aheadSha, baseSha);
      expect(ok).toBe(false);
      expect(await backend.resolveRef("acme", "hello", "main")).toBe(baseSha);
    });
  });
});
