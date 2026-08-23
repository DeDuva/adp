#!/usr/bin/env bash
# Fail when a branch is not named for the kind of change it carries.
#
# AGENTS.md §Branches names three prefixes — feat/, fix/, docs/ — and until 2026-08-23
# that convention lived only in the shape of the branches people happened to create. It
# held for 24 of the last 30 pull requests and then did not: codex/…, claude/…, m4/…,
# release/…, and one bare worktree-… name all reached main.
#
# The strays are worth reading carefully, because they are not carelessness. A web agent
# session names its branch after the harness — claude/adp-devrel-positioning-cw46vh —
# before the agent has read a single file, including the one that would have told it not
# to. So the convention cannot be enforced by asking people to remember it: by the time
# anyone reads AGENTS.md, the branch already exists. It has to be checked.
#
# Which is the same bargain as check-docs.sh and check-release.sh: a rule with an owner
# somewhere other than a guard is a rule that drifts.
set -euo pipefail

fail=0
note() { printf '%s\n' "$*" >&2; }

# In CI on a pull request, the branch under test is the head ref — HEAD itself is a
# detached merge commit, so asking git would get "HEAD". Everywhere else, ask git.
branch="${1:-${GITHUB_HEAD_REF:-}}"
if [ -z "$branch" ]; then
	branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
fi

# Nothing to check: a push build on main, a detached HEAD, a tag build, or a bare repo.
# This is a genuine no-op rather than a skipped check — there is no branch name to be
# wrong — so it does not need the ADP_REQUIRE_* treatment that guards a check which
# could silently stop running.
case $branch in
"" | HEAD | main)
	printf 'check-branch: no branch to check (%s).\n' "${branch:-detached}"
	exit 0
	;;
esac

case $branch in
feat/* | fix/* | docs/*) ;;
*)
	note "check-branch: '$branch' does not start with feat/, fix/ or docs/."
	note ""
	note "  feat/  new capability — a route, a plane, a milestone item"
	note "  fix/   something is wrong and this makes it right: bugs, hardening,"
	note "         CI and tooling repair, and version/release corrections"
	note "  docs/  prose, the published site, the plan and status files"
	note ""
	note "  If your session named this branch after its harness (claude/…, codex/…,"
	note "  cursor/…), that is the tool's default and not one of the three. Rename it:"
	note ""
	note "    git branch -m fix/what-this-actually-does"
	note ""
	note "  See AGENTS.md §Branches."
	fail=1
	;;
esac

# Shape, checked only once the prefix is right so the message above is never buried under
# a second complaint about the same name. Lowercase, and something after the slash: a
# bare "fix/" says less than no prefix at all.
if [ "$fail" -eq 0 ]; then
	case $branch in
	*/) note "check-branch: '$branch' has a prefix and no name after it." && fail=1 ;;
	esac
	if [ "$fail" -eq 0 ] && ! printf '%s' "$branch" | grep -qE '^(feat|fix|docs)/[a-z0-9][a-z0-9._-]*$'; then
		note "check-branch: '$branch' should be lowercase and hyphen-separated after the prefix,"
		note "              and flat — no second slash. See AGENTS.md §Branches."
		fail=1
	fi
fi

[ "$fail" -eq 0 ] || exit 1
printf "check-branch: '%s' is named for the kind of change it carries.\n" "$branch"
