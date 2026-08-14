import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitBackend, isSafeRepoSegment } from "./git-backend.js";

const execFileAsync = promisify(execFile);

// #89 (audit §P0-5): route params are %2F-decoded before they reach
// repoPath's path.join, so an owner like "../../tmp/x" would name a
// directory outside gitRoot. repoPath is the chokepoint every filesystem
// touch goes through; these prove it refuses, whatever the route forgot.
describe("isSafeRepoSegment / repoPath traversal guard", () => {
  it.each(["acme", "a-b_c.d", "runner-gates-owner-123", "UPPER"])("accepts %j", (segment) => {
    expect(isSafeRepoSegment(segment)).toBe(true);
  });

  it.each(["..", ".", "../../tmp/x", "a/b", "a\\b", "", "a b", "a\0b"])("rejects %j", (segment) => {
    expect(isSafeRepoSegment(segment)).toBe(false);
  });

  it("repoPath throws rather than join an unsafe owner, and exists() reads that as absent", async () => {
    const gitRoot = await mkdtemp(path.join(tmpdir(), "adp-git-backend-traversal-"));
    try {
      const backend = new GitBackend(gitRoot);
      expect(() => backend.repoPath("../../tmp/x", "hello")).toThrow(/Unsafe repo path segment/);
      expect(() => backend.repoPath("acme", "..")).toThrow(/Unsafe repo path segment/);
      expect(await backend.exists("../../tmp/x", "hello")).toBe(false);
    } finally {
      await rm(gitRoot, { recursive: true, force: true });
    }
  });
});

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

    // M4-9c: the tarball runner/src/docker.ts's `docker cp` puts inside an
    // isolated gate container — real `git archive`, extracted with the real
    // `tar` binary, not asserted against by shape alone.
    it("archiveTar produces a real tarball of the tree at a given sha", async () => {
      const tar = await backend.archiveTar("acme", "hello", aheadSha);
      const extractDir = await mkdtemp(path.join(tmpdir(), "adp-git-backend-archive-"));
      try {
        const tarPath = path.join(extractDir, "out.tar");
        await writeFile(tarPath, tar);
        await execFileAsync("tar", ["-xf", tarPath], { cwd: extractDir });
        const content = await readFile(path.join(extractDir, "file.txt"), "utf8");
        expect(content).toBe("one\ntwo\n");
      } finally {
        await rm(extractDir, { recursive: true, force: true });
      }
    });

    it("archiveTar reflects the tree at the given sha, not the current tip", async () => {
      const tar = await backend.archiveTar("acme", "hello", baseSha);
      const extractDir = await mkdtemp(path.join(tmpdir(), "adp-git-backend-archive-base-"));
      try {
        const tarPath = path.join(extractDir, "out.tar");
        await writeFile(tarPath, tar);
        await execFileAsync("tar", ["-xf", tarPath], { cwd: extractDir });
        const content = await readFile(path.join(extractDir, "file.txt"), "utf8");
        expect(content).toBe("one\n");
      } finally {
        await rm(extractDir, { recursive: true, force: true });
      }
    });

    // Mirror mode (M2): a second bare repo stands in for "GitHub" — no live
    // network, just two local bare repos exchanging refs via file:// paths.
    describe("mirror push/fetch against a second remote", () => {
      let mirrorRoot: string;
      let mirrorBackend: GitBackend;

      beforeEach(async () => {
        mirrorRoot = await mkdtemp(path.join(tmpdir(), "adp-git-backend-mirror-"));
        mirrorBackend = new GitBackend(mirrorRoot);
        await mirrorBackend.initBareRepo("github", "hello", "main");
      });

      afterEach(async () => {
        await rm(mirrorRoot, { recursive: true, force: true });
      });

      it("pushToRemote fast-forwards the remote's ref", async () => {
        const remotePath = mirrorBackend.repoPath("github", "hello");
        await backend.pushToRemote("acme", "hello", remotePath, `${baseSha}:refs/heads/main`);
        expect(await mirrorBackend.resolveRef("github", "hello", "main")).toBe(baseSha);
      });

      it("pushToRemote rejects a non-fast-forward push", async () => {
        const remotePath = mirrorBackend.repoPath("github", "hello");
        // Push both shas across first so the remote has the objects it
        // needs to build a divergent commit on top of baseSha.
        await backend.pushToRemote("acme", "hello", remotePath, `${aheadSha}:refs/heads/scratch`);

        const treeSha = (await execFileAsync("git", ["rev-parse", `${baseSha}^{tree}`], { cwd: remotePath })).stdout.trim();
        // Explicit author/committer env, not inherited global git config —
        // a bare CI container has none set, unlike a developer's machine,
        // and commit-tree refuses to run without one (core/git-backend.ts's
        // own createCommit sets these same four vars for the same reason).
        const divergedSha = (
          await execFileAsync("git", ["commit-tree", treeSha, "-p", baseSha, "-m", "diverged"], {
            cwd: remotePath,
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: "Test",
              GIT_AUTHOR_EMAIL: "test@example.com",
              GIT_COMMITTER_NAME: "Test",
              GIT_COMMITTER_EMAIL: "test@example.com",
            },
          })
        ).stdout.trim();
        await execFileAsync("git", ["update-ref", "refs/heads/main", divergedSha], { cwd: remotePath });

        await expect(backend.pushToRemote("acme", "hello", remotePath, `${aheadSha}:refs/heads/main`)).rejects.toThrow();
        expect(await mirrorBackend.resolveRef("github", "hello", "main")).toBe(divergedSha);
      });

      it("fetchFromRemote fetches a ref into FETCH_HEAD and returns its sha", async () => {
        const remotePath = mirrorBackend.repoPath("github", "hello");
        // Populate the mirror's objects via a real push first (objects
        // aren't shared between two separate bare repos), then fetch that
        // ref back into acme's repo.
        await backend.pushToRemote("acme", "hello", remotePath, `${aheadSha}:refs/heads/main`);

        const fetchedSha = await backend.fetchFromRemote("acme", "hello", remotePath, "refs/heads/main");
        expect(fetchedSha).toBe(aheadSha);
      });
    });
  });
});
