#!/usr/bin/env bash
# A worktree per task: create one that can actually run the suite, and take it
# down without the destructive spelling being the easy one.
#
# Working in a worktree rather than switching a shared checkout's branch is the
# normal way to work here — it is what lets one session run `make check` while
# another is mid-edit, and it is why `.gitignore` carries a note about
# dependency trees rather than only a rule.
#
# What a bare `git worktree add` leaves you with is a checkout that looks ready
# and is not: the repository is shared, and node_modules, .env.test and dist
# are not. So this does the three things that have to follow it — validate the
# branch name against the same rule CI enforces, branch off the *fetched*
# main rather than whatever the current checkout happens to be at, and install
# every dependency tree.
#
# `remove` exists for a smaller reason and a sharper one. `git worktree remove`
# refuses while node_modules is there, because it is untracked; the spelling
# everyone reaches for next is `--force`, which discards uncommitted work
# without mentioning it. That is the same trap `gh pr merge --delete-branch`
# set for stacked pull requests (AGENTS.md §Landing a stack): the destructive
# step became the default spelling of the safe one. So this checks for what you
# would lose *first*, and only then clears the dependency trees and removes the
# worktree with plain `git`.
set -uo pipefail

# shellcheck source=scripts/dev/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

# Where worktrees go unless told otherwise. Overridable because the convention
# is per-machine rather than per-repository: an agent harness that keeps its
# state under a directory of its own points this at that directory, and
# .gitignore already excludes both that shape and this default.
WORKTREE_ROOT="${ADP_WORKTREE_ROOT:-.worktrees}"

usage() {
  cat >&2 <<'EOF'
usage: worktree.sh add <branch> [dir]   # e.g. worktree.sh add fix/92-gate-job-lease
       worktree.sh remove <dir>
       worktree.sh list

  branch  feat/… fix/… docs/… — checked by the same rule CI enforces
  dir     defaults to $ADP_WORKTREE_ROOT/<name after the prefix> (.worktrees/…)
EOF
  exit 2
}

# The primary checkout, which is where `git worktree` has to be run from and
# which is not this script's own repo root when it is invoked from inside a
# worktree. `git rev-parse --path-format` would be tidier and is newer than the
# git this has to run against.
main_checkout() {
  git -C "$ADP_REPO_ROOT" worktree list --porcelain | awk '/^worktree /{print $2; exit}'
}

add() {
  local branch="${1:-}" dir="${2:-}"
  [ -n "$branch" ] || usage

  # The same check, from the same script, that fails the pull request — so a
  # name that is going to be rejected is rejected now, while renaming it is
  # one flag rather than a force-push and an abandoned branch.
  if ! bash "$ADP_REPO_ROOT/scripts/dev/check-branch.sh" "$branch" >/dev/null 2>&1; then
    bash "$ADP_REPO_ROOT/scripts/dev/check-branch.sh" "$branch" || true
    exit 1
  fi

  [ -n "$dir" ] || dir="$WORKTREE_ROOT/${branch#*/}"
  local root base
  root="$(main_checkout)"
  local abs="$root/$dir"
  case "$dir" in /*) abs="$dir" ;; esac

  if [ -e "$abs" ]; then
    fail "$abs already exists"
    exit 1
  fi

  section "base"
  # Off the fetched remote main, not the local one. A worktree branched from a
  # stale local main is the quiet version of this going wrong: everything
  # works, the pull request is just built on last week's tree and carries a
  # diff nobody asked for.
  if git -C "$root" fetch --quiet origin main 2>/dev/null; then
    ok "fetched origin/main"
    base="origin/main"
  else
    warn "could not reach origin — branching from the local main instead"
    base="main"
  fi
  info "$(git -C "$root" log --oneline -1 "$base")"

  section "worktree"
  git -C "$root" worktree add "$abs" -b "$branch" "$base" || exit 1
  ok "$abs on $branch"

  section "dependencies"
  # This checkout's deps.sh, pointed at the new worktree — not the new
  # worktree's own copy, which is whatever revision the branch was cut from and
  # need not have one.
  bash "$ADP_REPO_ROOT/scripts/dev/deps.sh" install "$abs" >/dev/null 2>&1 || {
    fail "npm ci failed"
    hint "cd $abs && make deps   # to see why"
    exit 1
  }
  ok "dependency trees installed"

  printf '\n'
  info "cd $abs"
  info "make up && make check"
  adp_summary "worktree"
}

remove() {
  local dir="${1:-}"
  [ -n "$dir" ] || usage
  local abs
  abs="$(cd "$dir" 2>/dev/null && pwd)" || {
    fail "$dir is not a directory"
    exit 1
  }

  if ! git -C "$ADP_REPO_ROOT" worktree list --porcelain | grep -qx "worktree $abs"; then
    fail "$abs is not a worktree of this repository"
    exit 1
  fi
  if [ "$abs" = "$(main_checkout)" ]; then
    fail "$abs is the primary checkout, not a worktree"
    exit 1
  fi
  # Removing the ground you are standing on leaves the shell in a directory
  # that no longer exists, and every command after it fails for a reason that
  # has nothing to do with what it was asked to do.
  if [ "$abs" = "$(pwd -P)" ]; then
    fail "$abs is the worktree you are in"
    hint "cd elsewhere first: cd $(main_checkout)"
    exit 1
  fi

  # **Uncommitted changes to tracked files are the only thing this destroys.**
  # The branch is never deleted here — see the last line of this function — so
  # its commits survive the worktree, pushed or not. Refusing over unpushed
  # commits, which is what this did at first, is a false alarm on the single
  # most common call: you have just landed a pull request and are cleaning up.
  # A safe spelling that cries wolf is how people end up back on `--force`,
  # which is the thing this exists to stop them needing.
  section "work you would lose"
  if [ -n "$(git -C "$abs" status --porcelain --untracked-files=no)" ]; then
    fail "uncommitted changes to tracked files"
    git -C "$abs" status --short --untracked-files=no | sed 's/^/        /'
    hint "nothing was removed"
    adp_summary "worktree"
    exit 1
  fi
  ok "no uncommitted changes"

  # Everything below is reported rather than enforced: it is what you would
  # want to know before walking away from the branch, not a reason to keep a
  # directory. Untracked files are the one thing neither this nor `git` will
  # discard silently — `git worktree remove` refuses over them below.
  local branch landed
  branch="$(git -C "$abs" rev-parse --abbrev-ref HEAD)"
  if [ "$branch" = "HEAD" ]; then
    info "detached HEAD — no branch to leave behind"
  else
    # `@{upstream}` is not usable here: after a landed pull request the remote
    # branch is gone, and `git rev-parse --abbrev-ref --symbolic-full-name`
    # answers a deleted upstream by printing the string `@{upstream}` back on
    # *stdout* and exiting 128 — so a `|| true` around it captures the literal
    # and every comparison after it is nonsense. Ask git something that is
    # still true instead.
    landed=""
    git -C "$abs" fetch --quiet origin main 2>/dev/null || true
    if git -C "$abs" diff --quiet HEAD origin/main 2>/dev/null; then
      # A squash merge puts this work on main under a *new* sha, so the branch
      # commits are reachable from no remote and every ancestry test calls them
      # unmerged. The trees agreeing is what actually answers "did this land".
      landed=1
      ok "'$branch' has landed — its tree is origin/main's"
    fi
    if [ -z "$landed" ]; then
      local local_only
      local_only="$(git -C "$abs" rev-list --count HEAD --not --remotes 2>/dev/null || echo 0)"
      if [ "$local_only" != "0" ]; then
        warn "'$branch' has $local_only commit(s) that are on no remote"
        hint "they stay on the branch, which this does not delete — but they are only here"
      else
        ok "'$branch' is on a remote"
      fi
    fi
  fi

  section "removing"
  # The dependency trees are the only reason plain `git worktree remove`
  # refuses, so clearing them is what makes the safe spelling the working one.
  for pkg in $ADP_DEP_PACKAGES dc-runtime; do
    rm -rf "${abs:?}/$pkg/node_modules"
  done
  git -C "$ADP_REPO_ROOT" worktree remove "$abs" || {
    fail "git worktree remove refused — something else untracked is in there"
    hint "git -C $abs status --short"
    exit 1
  }
  ok "removed $abs"
  # `-d` or `-D`, and it is the tree-versus-ancestry distinction again rather
  # than a matter of taste: `git branch -d` refuses a squash-merged branch,
  # because none of its commits is an ancestor of the main it landed on. So a
  # branch this function has just called landed needs `-D`, and printing `-d`
  # for it — which is what this said at first — is advice that cannot work.
  # `-d` stays the suggestion everywhere else, where its refusal is the point.
  if [ -n "${landed:-}" ]; then
    info "the branch itself is untouched: git branch -D $branch"
    hint "-D because the squash merge left none of its commits on main; -d would refuse"
  elif [ "$branch" != "HEAD" ]; then
    info "the branch itself is untouched: git branch -d $branch"
  fi
  adp_summary "worktree"
}

case "${1:-}" in
add)
  shift
  add "$@"
  ;;
remove)
  shift
  remove "$@"
  ;;
list) git -C "$ADP_REPO_ROOT" worktree list ;;
*) usage ;;
esac
