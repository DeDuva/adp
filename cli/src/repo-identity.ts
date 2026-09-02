import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Which ADP repository this checkout is, **recorded** rather than derived.
//
// It used to be derived, from a git remote whose host matched the configured
// server. That composed — `adp init` added the remote `adp connect` then found
// — and it composed by coincidence: a repository's identity lived in mutable
// local git state, so renaming or removing a remote broke every subsequent ADP
// command with an error about remotes rather than about configuration.
//
// In companion mode it is worse than fragile. There is nothing to push to ADP:
// the developer pushes to GitHub and ADP observes. The remote `init` used to add
// unconditionally was an artifact of a mode the developer is not in.
//
// **Per clone, in the git directory**, on the same reasoning `connect` uses for
// excluding its files: one developer's setup is not every contributor's
// business, and `--git-path` rather than `.git/` so a worktree gets its own
// answer instead of the main checkout's.

export interface RepoIdentity {
  /** Which instance this identity is for. A checkout can be connected to one at a time. */
  serverUrl: string;
  owner: string;
  repo: string;
  /**
   * `mirror` when the code lives upstream and ADP observes, `native` when the
   * developer pushes to ADP. Recorded because it decides whether an ADP git
   * remote should exist at all, and because "which mode is this repository in"
   * is otherwise a question answered by looking at remotes — the inference this
   * file exists to remove.
   */
  mode: "mirror" | "native";
}

function identityPath(dir: string): string | null {
  try {
    const relative = execFileSync("git", ["rev-parse", "--git-path", "adp.json"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!relative) return null;
    return path.isAbsolute(relative) ? relative : path.join(dir, relative);
  } catch {
    return null;
  }
}

export function saveRepoIdentity(root: string, identity: RepoIdentity): boolean {
  const file = identityPath(root);
  if (!file) return false;
  writeFileSync(file, JSON.stringify(identity, null, 2) + "\n");
  return true;
}

/**
 * The recorded identity, if this checkout has one for this server.
 *
 * Scoped to the server: a checkout recorded against one instance must not be
 * silently reused against another, because the same `owner/repo` on a different
 * instance is a different repository and every command would report success
 * against the wrong one.
 */
export function loadRepoIdentity(root: string, serverUrl: string): RepoIdentity | null {
  const file = identityPath(root);
  if (!file || !existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RepoIdentity>;
    if (!parsed.owner || !parsed.repo || !parsed.serverUrl) return null;
    if (normalize(parsed.serverUrl) !== normalize(serverUrl)) return null;
    return {
      serverUrl: parsed.serverUrl,
      owner: parsed.owner,
      repo: parsed.repo,
      mode: parsed.mode === "native" ? "native" : "mirror",
    };
  } catch {
    return null;
  }
}

export function forgetRepoIdentity(root: string): boolean {
  const file = identityPath(root);
  if (!file || !existsSync(file)) return false;
  rmSync(file);
  return true;
}

function normalize(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}
