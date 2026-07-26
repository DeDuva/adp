import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitBackend } from "./git-backend.js";

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
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("git", ["config", "http.receivepack"], {
      cwd: backend.repoPath("acme", "hello"),
    });
    expect(stdout.trim()).toBe("true");
  });
});
