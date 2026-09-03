import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRepoIdentity, saveRepoIdentity, forgetRepoIdentity } from "../src/repo-identity.js";
import { resolveRepoTarget } from "../src/commands/connect.js";

// #238 — a repository's identity is recorded, not inferred.
//
// It used to be derived from a git remote whose host matched the configured
// server. That composed with `adp init` — which added the remote — and it
// composed by coincidence: identity lived in mutable local git state, so
// renaming or removing a remote broke every subsequent ADP command with an
// error about remotes rather than about configuration.
//
// In companion mode it was worse than fragile: there is nothing to push to ADP,
// so the remote was an artifact of a mode the developer is not in.
describe("#238: recorded repository identity", () => {
  let repo: string;
  const server = "https://adp.example.com";

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "adp-identity-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("lives in the git directory, so it cannot be committed by accident", () => {
    expect(saveRepoIdentity(repo, { serverUrl: server, owner: "acme", repo: "widget", mode: "mirror" })).toBe(true);
    expect(existsSync(path.join(repo, ".git", "adp.json"))).toBe(true);
    expect(existsSync(path.join(repo, "adp.json"))).toBe(false);
  });

  it("round-trips what init recorded", () => {
    saveRepoIdentity(repo, { serverUrl: server, owner: "acme", repo: "widget", mode: "mirror" });
    expect(loadRepoIdentity(repo, server)).toEqual({
      serverUrl: server,
      owner: "acme",
      repo: "widget",
      mode: "mirror",
    });
  });

  // The same `owner/repo` on a different instance is a different repository,
  // and every command would report success against the wrong one.
  it("does not answer for a different server", () => {
    saveRepoIdentity(repo, { serverUrl: server, owner: "acme", repo: "widget", mode: "mirror" });
    expect(loadRepoIdentity(repo, "https://other.example.com")).toBeNull();
    // A trailing slash or a difference in case is the same instance.
    expect(loadRepoIdentity(repo, "https://ADP.example.com/")).not.toBeNull();
  });

  it("survives a corrupt file rather than throwing at a command that only wanted a name", () => {
    writeFileSync(path.join(repo, ".git", "adp.json"), "{not json");
    expect(loadRepoIdentity(repo, server)).toBeNull();
  });

  it("forgets on request, and reports whether there was anything to forget", () => {
    expect(forgetRepoIdentity(repo)).toBe(false);
    saveRepoIdentity(repo, { serverUrl: server, owner: "acme", repo: "widget", mode: "native" });
    expect(forgetRepoIdentity(repo)).toBe(true);
    expect(loadRepoIdentity(repo, server)).toBeNull();
  });

  describe("resolving which repository a command is about", () => {
    it("uses the recording, with no remote of any kind present", () => {
      saveRepoIdentity(repo, { serverUrl: server, owner: "acme", repo: "widget", mode: "mirror" });
      expect(resolveRepoTarget(repo, server, undefined)).toEqual({ owner: "acme", repo: "widget" });
    });

    it("keeps working when the remote it was once inferred from is renamed away", () => {
      execFileSync("git", ["remote", "add", "adp", `${server}/acme/widget.git`], { cwd: repo });
      // The first command infers — and writes the answer down.
      expect(resolveRepoTarget(repo, server, undefined)).toEqual({ owner: "acme", repo: "widget" });
      expect(loadRepoIdentity(repo, server)).not.toBeNull();

      // After which the remote is no longer load bearing. This is the whole
      // point: a clone infers at most once, and never again.
      execFileSync("git", ["remote", "rename", "adp", "somewhere-else"], { cwd: repo });
      execFileSync("git", ["remote", "set-url", "somewhere-else", "https://elsewhere.example.com/x.git"], {
        cwd: repo,
      });
      expect(resolveRepoTarget(repo, server, undefined)).toEqual({ owner: "acme", repo: "widget" });
    });

    it("prefers an explicit --repo over anything recorded", () => {
      saveRepoIdentity(repo, { serverUrl: server, owner: "acme", repo: "widget", mode: "mirror" });
      expect(resolveRepoTarget(repo, server, "other/thing")).toEqual({ owner: "other", repo: "thing" });
    });

    // The old message named remotes, which is a fact about git rather than
    // about what the user has to do.
    it("names the command that attaches a checkout, rather than talking about remotes", () => {
      expect(() => resolveRepoTarget(repo, server, undefined)).toThrow(/adp init/);
      expect(() => resolveRepoTarget(repo, server, undefined)).toThrow(/--repo <owner>\/<repo>/);
    });
  });
});
