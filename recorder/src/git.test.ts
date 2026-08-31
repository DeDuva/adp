import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { headIntentTrailer, headSha } from "./git.js";

/** A real repository, because the thing being tested is what git says. */
function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "adp-recorder-git-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  return dir;
}

function commit(dir: string, message: string): void {
  writeFileSync(path.join(dir, "f.txt"), `${Math.random()}`);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
}

describe("what the working directory can tell the recorder", () => {
  let dir: string;
  beforeAll(() => {
    dir = repo();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("answers null rather than throwing outside a repository", () => {
    // Recording must survive being started anywhere. A session recorded
    // without commit boundaries is a session recorded; one lost because there
    // was no repository is not.
    const empty = mkdtempSync(path.join(tmpdir(), "adp-recorder-nogit-"));
    expect(headSha(empty)).toBeNull();
    expect(headIntentTrailer(empty)).toBeNull();
    rmSync(empty, { recursive: true, force: true });
  });

  it("answers null on an unborn branch", () => {
    // `git init` with no commit: a repository with no HEAD.
    expect(headSha(dir)).toBeNull();
  });

  it("reads the intent trailer off HEAD", () => {
    commit(dir, "Fix the retry backoff\n\nADP-Intent: 41\n");
    expect(headSha(dir)).toMatch(/^[0-9a-f]{40}$/);
    expect(headIntentTrailer(dir)).toBe("41");
  });

  it("ignores an intent merely discussed in the body", () => {
    // Git's own rule, and the reason it matters: only the last
    // blank-line-separated block counts, and only when every line in it is
    // trailer-shaped. A commit that talks about `ADP-Intent: 41` must not
    // silently bind the session to intent 41.
    commit(dir, "Explain the binding\n\nThe trailer looks like\nADP-Intent: 41\nand rides on git.\n");
    expect(headIntentTrailer(dir)).toBeNull();
  });

  it("takes the last value when the trailer appears twice", () => {
    commit(dir, "Two\n\nADP-Intent: 1\nADP-Intent: 2\n");
    expect(headIntentTrailer(dir)).toBe("2");
  });

  it("treats an empty trailer as absent", () => {
    commit(dir, "Empty\n\nADP-Intent:\nADP-Session: s\n");
    expect(headIntentTrailer(dir)).toBeNull();
  });

  it("reads a UUID trailer as written", () => {
    commit(dir, "UUID\n\nADP-Intent: 11111111-2222-3333-4444-555555555555\n");
    expect(headIntentTrailer(dir)).toBe("11111111-2222-3333-4444-555555555555");
  });
});
