#!/usr/bin/env bash
# Merge a pull request without destroying the ones stacked on it.
#
# Deleting the base branch of an open pull request does not orphan it — GitHub
# *closes* it, and a closed pull request whose base branch is gone can be neither
# reopened nor retargeted. The work is recoverable; the review thread, its number
# and every link pointing at it are not. That happened twice here in one afternoon
# (#172 and #180), and the second time the branch was deleted by
# `gh pr merge --delete-branch`, which makes the destructive step the *default*
# spelling of the safe one.
#
# So the rule is not "remember to check first". Nobody checks first — by the time
# anyone thinks to, the child is closed. The rule is that the ordinary way to land
# a change looks at the dependents itself, and refuses the deletion when there are
# any. That is the same bargain as check-branch.sh: a convention with no guard is a
# convention that drifts, and this one drifts silently.
#
#   bash scripts/dev/land.sh 181          # or: make land PR=181
#
# What it will not do: merge a pull request whose checks are not green, merge one
# GitHub reports as unmergeable, or delete a branch another open pull request is
# based on. Each refusal names the thing to do instead.
set -euo pipefail

pr=${1:-}
[ -n "$pr" ] || { printf 'usage: %s <pr-number>\n' "$0" >&2; exit 2; }
command -v gh >/dev/null || { printf 'land: needs the gh CLI\n' >&2; exit 2; }

repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)

read -r state head base title < <(
	gh pr view "$pr" --repo "$repo" \
		--json state,headRefName,baseRefName,title \
		-q '[.state, .headRefName, .baseRefName, .title] | @tsv'
)

[ "$state" = OPEN ] || { printf 'land: #%s is %s, not OPEN.\n' "$pr" "$state" >&2; exit 1; }

printf 'land: #%s  %s\n      %s → %s\n\n' "$pr" "$title" "$head" "$base"

# ---------------------------------------------------------------------------
# 1. Green, and mergeable. `gh pr checks` exits non-zero while anything is
#    pending or failing, which is the distinction we want: this refuses to be the
#    thing that merges on a yellow build.
# ---------------------------------------------------------------------------
if ! gh pr checks "$pr" --repo "$repo" >/dev/null 2>&1; then
	printf 'land: checks are not all passing. Watch them with:\n\n' >&2
	printf '  gh pr checks %s --repo %s --watch\n' "$pr" "$repo" >&2
	exit 1
fi

mergeable=$(gh pr view "$pr" --repo "$repo" --json mergeable -q .mergeable)
if [ "$mergeable" != MERGEABLE ]; then
	printf 'land: GitHub reports #%s as %s. Rebase it on %s first.\n' "$pr" "$mergeable" "$base" >&2
	exit 1
fi

# ---------------------------------------------------------------------------
# 2. Anything stacked on this branch? Asked before the merge, because after the
#    deletion there is nothing left to ask about.
# ---------------------------------------------------------------------------
deps=$(gh pr list --repo "$repo" --state open --base "$head" --json number,headRefName \
	-q '.[] | "#\(.number) (\(.headRefName))"')

# ---------------------------------------------------------------------------
# 3. Merge. Squash, because that is what every merge in this repository's history
#    is, and it is what makes the child branch need a rebase in the first place.
# ---------------------------------------------------------------------------
if [ -n "$deps" ]; then
	printf 'land: keeping the branch — these open pull requests are based on it:\n' >&2
	printf '%s\n' "$deps" | sed 's/^/        /' >&2
	printf '\n' >&2
	gh pr merge "$pr" --repo "$repo" --squash
	printf '\nland: merged #%s. Branch %s is kept so those stay open.\n\n' "$pr" "$head"
	printf 'For each of them: rebase onto %s (the squash makes this drop the merged\n' "$base"
	printf 'commit as already applied), push with --force-with-lease, retarget with\n'
	printf '`gh pr edit <n> --base %s`, and delete %s once the last one has landed:\n\n' "$base" "$head"
	printf '  bash scripts/dev/land.sh <n>   # and this script will delete it for you\n'
else
	gh pr merge "$pr" --repo "$repo" --squash --delete-branch
	printf '\nland: merged #%s and deleted %s — nothing was based on it.\n' "$pr" "$head"
fi
