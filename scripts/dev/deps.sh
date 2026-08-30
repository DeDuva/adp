#!/usr/bin/env bash
# The node dependency trees this checkout needs — installed, or checked.
#
# `deps.sh check` exists because of how the missing ones actually surface.
# `make check` runs for forty minutes and then dies in the seventh target with
#
#     sh: 1: vitest: not found
#     make[2]: *** [Makefile:105: adapters] Error 127
#
# which names neither the cause nor the remedy, and arrives after everything
# expensive has already run. That is the whole failure this guards: the answer
# is knowable in milliseconds before the first test starts, so it is asked
# there instead.
#
# It became worth guarding when worktree-per-task became the normal way to work
# here. A fresh `git worktree add` shares the repository and shares nothing
# else: no node_modules, no .env.test, no dist. `npm ci` across all five trees
# takes about eight seconds against a warm npm cache, so the cost of getting
# this right is not the install — it is finding out, and this makes finding out
# free.
#
# **Install rather than link.** Sharing one machine's dependency tree between
# worktrees by symlink is the obvious shortcut and it is a trap twice over: the
# link silently serves the *other* checkout's dependencies when the two
# lockfiles disagree, and two machine-specific absolute symlinks reached main
# that way in #128 — which is why .gitignore matches `node_modules` without a
# trailing slash. Eight seconds buys a tree that is actually this checkout's.
set -uo pipefail

# shellcheck source=scripts/dev/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() {
  cat >&2 <<'EOF'
usage: deps.sh install [root]   # npm ci every tree, and stamp each with its lockfile digest
       deps.sh check   [root]   # report whether every tree is present and current

  root  defaults to this script's own checkout. worktree.sh passes the new
        worktree's path, so a worktree created on a revision that predates this
        script still gets its dependencies from the script you actually ran.
EOF
  exit 2
}

# The checkout to act on. Overriding what config.sh resolved from this file's
# own location is the whole point of the argument — see the usage note above.
if [ -n "${2:-}" ]; then
  ADP_REPO_ROOT="$(cd "$2" 2>/dev/null && pwd)" || {
    printf 'deps.sh: %s is not a directory\n' "$2" >&2
    exit 1
  }
fi

install_all() {
  section "installing"
  for pkg in $ADP_DEP_PACKAGES; do
    npm ci --prefix "$ADP_REPO_ROOT/$pkg" || {
      fail "npm ci failed in $pkg"
      adp_summary "deps"
      exit 1
    }
    # Stamped after the install, never before: a stamp written ahead of a
    # failed install would claim a tree that does not exist.
    adp_lock_digest "$pkg" > "$ADP_REPO_ROOT/$pkg/node_modules/$ADP_DEPS_STAMP"
    ok "$pkg"
  done
  adp_summary "deps"
}

# The gate. Every state that would break a run is a FAIL here rather than a
# warning, because the caller is `make test-all` and there is nothing advisory
# about it — `make doctor` is where the same facts are advice.
check_all() {
  section "dependencies"
  for pkg in $ADP_DEP_PACKAGES; do
    case "$(adp_dep_state "$pkg")" in
    ok) ok "$pkg" ;;
    missing)
      fail "$pkg/node_modules is missing"
      ;;
    stale)
      fail "$pkg/node_modules was installed from a different package-lock.json"
      hint "the tree predates a dependency change on this branch; CI would use the lockfile"
      ;;
    esac
  done
  if [ "$ADP_FAILURES" -gt 0 ]; then
    hint "make deps   # all five trees, about eight seconds against a warm npm cache"
  fi
  adp_summary "deps"
}

case "${1:-}" in
install) install_all ;;
check) check_all ;;
*) usage ;;
esac
