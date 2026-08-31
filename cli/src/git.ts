// The repository `adp connect` is connecting, and the hook that binds its
// commits to an intent.
//
// Both halves exist to remove something a person would otherwise type. The
// repo is derivable from the remote that already points at this ADP; the
// intent is derivable from the branch, on this repository's own naming
// convention and on everyone else's. Phase 1's rule is that an input ADP can
// compute and a human is supplying is a defect, and these are two of them.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Where per-clone ignores go — `info/exclude`, which is not committed and not the project's business. */
export function excludeFile(dir: string): string | null {
  const info = git(dir, ["rev-parse", "--git-path", "info/exclude"]);
  if (!info) return null;
  return path.isAbsolute(info) ? info : path.join(repoRoot(dir) ?? dir, info);
}

export const EXCLUDE_HEADER = "# adp connect: holds an ADP credential — never commit these";

/**
 * Keep the files connect writes out of commits.
 *
 * **They contain a bearer token.** A harness reads its MCP configuration from a
 * file in the repository, and that file has to carry the credential for the
 * harness to authenticate — so `adp connect` puts a live token inside the
 * working tree, and the very next `git add -A` would publish it. Some harnesses
 * can expand an environment variable instead, but then connecting is no longer
 * one command: the developer has to have exported the token first, which is one
 * of the things #154 exists to stop asking.
 *
 * So the files are excluded per clone. `info/exclude` rather than `.gitignore`
 * because a `.gitignore` entry is itself a commit, and telling every other
 * contributor's tooling about one developer's harness is not connect's business.
 * The block is marked, so disconnect removes exactly what connect added.
 */
export function excludePaths(dir: string, paths: string[]): boolean {
  const file = excludeFile(dir);
  if (!file) return false;
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  const wanted = new Set([...readExcluded(before), ...paths]);
  writeFileSync(file, writeExcluded(before, [...wanted].sort()));
  return true;
}

export function unexcludePaths(dir: string, paths: string[]): boolean {
  const file = excludeFile(dir);
  if (!file || !existsSync(file)) return false;
  const before = readFileSync(file, "utf8");
  const remaining = readExcluded(before).filter((p) => !paths.includes(p));
  const after = writeExcluded(before, remaining);
  if (after === before) return false;
  writeFileSync(file, after);
  return true;
}

function readExcluded(before: string): string[] {
  const lines = before.split("\n");
  const start = lines.indexOf(EXCLUDE_HEADER);
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.startsWith("#")) break;
    out.push(line);
  }
  return out;
}

function writeExcluded(before: string, paths: string[]): string {
  const lines = before.split("\n");
  const start = lines.indexOf(EXCLUDE_HEADER);
  let kept = lines;
  if (start !== -1) {
    let end = start + 1;
    while (end < lines.length && lines[end]!.trim() !== "" && !lines[end]!.startsWith("#")) end++;
    kept = [...lines.slice(0, start), ...lines.slice(end)];
  }
  const body = kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  if (paths.length === 0) return body ? `${body}\n` : "";
  const block = [EXCLUDE_HEADER, ...paths].join("\n");
  return body ? `${body}\n\n${block}\n` : `${block}\n`;
}

export function repoRoot(dir: string): string | null {
  return git(dir, ["rev-parse", "--show-toplevel"]);
}

/** Where hooks go — `--git-path hooks` rather than `.git/hooks`, so a worktree gets its own answer. */
export function hooksDir(dir: string): string | null {
  const relative = git(dir, ["rev-parse", "--git-path", "hooks"]);
  if (!relative) return null;
  return path.isAbsolute(relative) ? relative : path.join(repoRoot(dir) ?? dir, relative);
}

/**
 * Which ADP repository this checkout is, read off the remote that points at
 * this server.
 *
 * Matched against the configured server URL rather than by shape, because a
 * checkout can have several remotes and only one of them is the forge being
 * connected — guessing from `origin` alone would cheerfully connect a GitHub
 * clone to an ADP instance and report success.
 */
export function remoteRepo(dir: string, serverUrl: string): { owner: string; repo: string } | null {
  const remotes = git(dir, ["remote", "-v"]);
  if (!remotes) return null;
  let host: string;
  try {
    host = new URL(serverUrl).host;
  } catch {
    return null;
  }
  for (const line of remotes.split("\n")) {
    const url = line.split(/\s+/)[1];
    if (!url) continue;
    // Credentials in the URL are ordinary here — a token as the git password
    // is how this repository documents cloning — so the host comparison has to
    // survive them, which `new URL` handles and a substring match would not.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.host !== host) continue;
    const parts = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
    if (parts.length >= 2 && parts[0] && parts[1]) return { owner: parts[0], repo: parts[1] };
  }
  return null;
}

/**
 * The `prepare-commit-msg` hook, which is the client half #142 never had.
 *
 * #142 taught the *server* to read an `ADP-Intent` trailer off a pushed commit.
 * Writing one stayed a thing a person or an agent had to remember, and the
 * binding is worth exactly as much as the remembering is reliable. The hook
 * makes it automatic for the case that covers this repository's own convention
 * and most others': a branch named for the issue it answers.
 *
 * What it deliberately does not do:
 *
 *   - **Overwrite a trailer somebody wrote.** An explicit `ADP-Intent` wins,
 *     always. The hook is a default, not a policy.
 *   - **Run on a merge, a squash, or a commit being amended or reworded.**
 *     `$2` says which of those is happening, and appending a trailer to a
 *     message git assembled is how a merge commit acquires an intent nobody
 *     chose.
 *   - **Guess from anything but an explicit source.** `branch.<name>.adpIntent`
 *     first, then a leading number in the branch name. A branch with neither
 *     gets no trailer rather than a plausible one, because a wrong intent
 *     binds the change to work it did not do — which is worse than no binding,
 *     and much harder to notice.
 */
export const HOOK_MARKER = "# installed by `adp connect` — remove with `adp disconnect`";

export function hookScript(): string {
  return `#!/bin/sh
${HOOK_MARKER}
#
# Adds an ADP-Intent trailer naming the issue this branch answers, so a plain
# \`git push\` binds the change to its intent with no ADP API call (#142).
set -e

message_file="$1"
source="$2"

# merge, squash, commit -c/-C/--amend, and a message from a template are all
# messages git or a template assembled. A trailer appended to one of those
# binds a change to an intent nobody chose.
case "$source" in
merge | squash | commit | template) exit 0 ;;
esac

# An explicit trailer wins. This is a default, not a policy.
if grep -qiE '^ADP-Intent:[[:space:]]*[^[:space:]]' "$message_file"; then
  exit 0
fi

intent=""
branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)
if [ -n "$branch" ]; then
  intent=$(git config --get "branch.$branch.adpIntent" 2>/dev/null || true)
  if [ -z "$intent" ]; then
    # feat/151-session-lifecycle -> #151. A branch with no number gets no
    # trailer: a wrong intent is worse than none and harder to notice.
    intent=$(printf '%s' "$branch" | sed -n 's|^[^/]*/\\{0,1\\}\\([0-9][0-9]*\\)[-_].*$|#\\1|p')
  fi
fi
[ -n "$intent" ] || exit 0

# Git's own rule: a trailer belongs in the last blank-line-separated block, and
# that block has to be all trailers. \`git interpret-trailers\` knows this; doing
# it by hand is how a trailer ends up inside a paragraph and silently ignored.
git interpret-trailers --if-exists doNothing --trailer "ADP-Intent=$intent" --in-place "$message_file"
`;
}

export type HookOutcome = "installed" | "updated" | "foreign";

/**
 * Install the hook, and never over somebody else's.
 *
 * A `prepare-commit-msg` that ADP did not write is somebody's work, so it is
 * reported rather than replaced. Refusing here costs a manual step; the
 * alternative costs a hook nobody kept a copy of.
 */
export function installHook(hooks: string): { file: string; outcome: HookOutcome } {
  const file = path.join(hooks, "prepare-commit-msg");
  if (existsSync(file) && !readFileSync(file, "utf8").includes(HOOK_MARKER)) {
    return { file, outcome: "foreign" };
  }
  const updated = existsSync(file);
  mkdirSync(hooks, { recursive: true });
  writeFileSync(file, hookScript(), { mode: 0o755 });
  chmodSync(file, 0o755);
  return { file, outcome: updated ? "updated" : "installed" };
}

export function removeHook(hooks: string): { file: string; removed: boolean } {
  const file = path.join(hooks, "prepare-commit-msg");
  if (!existsSync(file) || !readFileSync(file, "utf8").includes(HOOK_MARKER)) {
    return { file, removed: false };
  }
  rmSync(file, { force: true });
  return { file, removed: true };
}
