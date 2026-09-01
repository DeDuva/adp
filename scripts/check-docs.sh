#!/usr/bin/env bash
# Fail when a tracked document has quietly stopped being true.
#
# This started as a check over the project-instructions file alone, asserting one thing:
# every repo-relative path in it still exists. That guard worked and never fired. The
# 2026-08-22 documentation audit then found sixteen contradictions it could not have
# caught, because none of them were about a path — they were about *claims*:
#
#   - The status ledger said the 0.3.0 contract batch was "not started" while the same
#     file recorded the contract version as 0.3.0 and the tag v0.3.0 existed.
#   - It said M4-5 Google OIDC "is built and acceptance-tested against real Google".
#     There was no OIDC code in the tree at the time, and the claim had already
#     propagated to two other documents.
#   - It listed P2 items #98-#102 as still to come. All five closed on 2026-08-14.
#   - AGENTS.md described the `gh pr checks` gap as deliberately asserted, nineteen days
#     after PR #53 closed it and inverted the assertion — in a passage that had
#     *predicted* exactly this failure and named the documents that would need fixing.
#
# The common shape: a fact with an owner elsewhere (git, the issue tracker, another
# file) was copied into prose, the owner moved, and the copy did not. So this script
# checks three things a human reviewer reliably does not:
#
#   1. every repo-relative path referenced in tracked markdown exists;
#   2. every relative markdown link resolves to a file that exists;
#   3. every issue/PR number cited in the status documents agrees with its real state.
#
# (3) needs `gh` and the network. Per AGENTS.md's standing invariant — a check that can
# skip itself is a check that can silently stop running — it skips loudly when `gh` is
# unavailable and becomes a hard failure when ADP_REQUIRE_GH=1, which CI sets.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

fail=0
note() { printf '%s\n' "$*" >&2; }

# The tracked-file list is consulted once per reference, so it lives in temp files
# rather than in a variable piped into a reader. That is not an optimisation: a reader
# that exits early (`grep -q`, `awk … { exit }`) closes the pipe, the writer dies of
# SIGPIPE, and `set -o pipefail` reports the whole pipeline as failed — so a tracked
# file intermittently reads as missing, depending on which side wins the race. An
# intermittently-failing guard gets switched off, which is the one outcome this script
# cannot afford. Reading from a file has no writer to kill.
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

git ls-files >"$tmpdir/tracked"
cut -d/ -f1 <"$tmpdir/tracked" | sort -u >"$tmpdir/toplevel"
# Symlinks are skipped: CLAUDE.md points at AGENTS.md so that an agent looking for the
# older name finds the same text, and scanning both reports every finding twice under two
# names. A guard whose output is half duplicates is one people stop reading.
grep -E '\.md$' <"$tmpdir/tracked" | while IFS= read -r f; do
	[ -L "$f" ] || printf '%s\n' "$f"
done >"$tmpdir/docs" || true
docs=$(cat "$tmpdir/docs")

is_tracked() {
	p=${1%/}
	grep -qxF "$p" "$tmpdir/tracked" || grep -q "^$(printf '%s' "$p" | sed 's/[.[\*^$\/]/\\&/g')/" "$tmpdir/tracked"
}

is_toplevel() {
	grep -qxF "$1" "$tmpdir/toplevel"
}

# References whose first segment collides with one of our top-level directories but
# which are not paths in this repository, or are build output that only exists after a
# build. Each needs a reason; an unexplained entry here is how a guard rots.
is_exempt() {
	case $1 in
	cli/cli) return 0 ;;                 # the GitHub org/repo `cli/cli`, not our cli/
	scripts/setup-stats.sh) return 0 ;;  # lives in squad's packages/duva-bench, per ecosystem.md
	server/web/dist) return 0 ;;         # build output; exists only after `make web`
	*) return 1 ;;
	esac
}

# ---------------------------------------------------------------------------
# 1. Repo-relative paths in backticks resolve.
#
# Every backticked token that looks like a repo path and whose first segment is a
# tracked top-level entry must itself be tracked. Tokens rooted anywhere else —
# /api/adp, ~/.config, https://…, a sibling repository's layout — are references to
# things outside this tree and are left alone.
# ---------------------------------------------------------------------------
for doc in $docs; do
	refs=$(
		grep -o '`[^`]*`' "$doc" 2>/dev/null |
			tr -d '`' |
			grep '/' |
			grep -v '[ 	<>*$=~()|]' |
			grep -v '://' |
			grep -v '^[/@-]' |
			sort -u || true
	)
	for ref in $refs; do
		# `server/src/core/land.ts:162` and `docker.ts:61-80` are file:line citations —
		# the useful kind of reference. Check the file, ignore the coordinates.
		ref=${ref%%:[0-9]*}
		is_toplevel "${ref%%/*}" || continue
		is_exempt "$ref" && continue
		git check-ignore -q "$ref" && continue
		is_tracked "$ref" && continue
		note "check-docs: $doc references a path that does not exist: $ref"
		fail=1
	done
done

# ---------------------------------------------------------------------------
# 2. Relative markdown links resolve.
#
# A [text](docs/foo.md) that 404s on GitHub is the same class of decay as a moved
# path, and the archive split in the v6 reset moves enough files to make this worth
# enforcing. Anchors, absolute URLs and mailto: are out of scope.
# ---------------------------------------------------------------------------
for doc in $docs; do
	dir=$(dirname "$doc")
	targets=$(
		grep -o ']([^)]*)' "$doc" 2>/dev/null |
			sed 's/^](//; s/)$//' |
			grep -v '://' |
			grep -v '^#' |
			grep -v '^mailto:' |
			sed 's/#.*$//' |
			grep -v '^$' |
			sort -u || true
	)
	for t in $targets; do
		case $t in /*) continue ;; esac
		resolved=$(cd "$dir" && printf '%s' "$(realpath -m --relative-to="$(git rev-parse --show-toplevel)" "$t")")
		is_tracked "$resolved" && continue
		[ -e "$resolved" ] && continue
		note "check-docs: $doc links to a file that does not exist: $t"
		fail=1
	done
done

# ---------------------------------------------------------------------------
# 3. Issue and PR numbers in the status documents agree with reality.
#
# The status documents are the ones whose whole job is to be current. For each #NNN
# they cite, compare the surrounding line's claim against the real state:
#
#   - a line that calls the item done while the issue is OPEN is wrong;
#   - a line that calls it outstanding while the issue is CLOSED is wrong.
#
# Lines making neither claim, or both, are left alone — the check reports only what it
# can be sure about, because a guard that cries wolf gets disabled.
# ---------------------------------------------------------------------------
STATUS_DOCS="PLAN.md"

gh_ok=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
	gh_ok=1
fi

if [ "$gh_ok" -eq 0 ]; then
	if [ "${ADP_REQUIRE_GH:-0}" = "1" ]; then
		note "check-docs: ADP_REQUIRE_GH=1 but gh is unavailable or unauthenticated."
		note "            The issue-state check is the one that catches stale status claims;"
		note "            CI must not pass without it."
		exit 1
	fi
	note "check-docs: skipping the issue-state check (no authenticated gh)."
	note "            Set ADP_REQUIRE_GH=1 to make this a failure, as CI does."
else
	# One list call per kind, not one view call per number. The status docs cite tens of
	# issues; at a round-trip each this check took ~40s and would have been the slowest
	# thing in `make check` for no reason.
	{
		gh issue list --state all --limit 500 --json number,state \
			-q '.[] | "\(.number)\t\(.state)"'
		gh pr list --state all --limit 500 --json number,state \
			-q '.[] | "\(.number)\t\(.state)"'
	} >"$tmpdir/states" 2>/dev/null || true

	# The pull request this run is checking, if any: its own claims about itself
	# are exempt (see the loop below). GITHUB_REF is refs/pull/N/merge on a PR
	# build; locally, ask gh what PR the current branch belongs to.
	self_pr=""
	case "${GITHUB_REF:-}" in
	refs/pull/*) self_pr=$(printf '%s' "$GITHUB_REF" | cut -d/ -f3) ;;
	*) self_pr=$(gh pr view --json number -q .number 2>/dev/null || echo "") ;;
	esac

	# ...and the issues this change closes. Finishing an item means closing its
	# issue, and the issue is open until the merge — so without this, a PR that
	# correctly marks item 1-1 done because it closes #103 fails on #103 being
	# open. Exactly the inversion the self-exemption fixes, one hop further out.
	#
	# Two sources, because neither covers both situations. GitHub resolves the
	# PR's closing references, which is authoritative but needs the PR to exist;
	# the commit trailers work locally before one has been opened.
	self_closes=""
	if [ -n "$self_pr" ]; then
		self_closes=$(gh pr view "$self_pr" --json closingIssuesReferences \
			-q '.closingIssuesReferences[].number' 2>/dev/null || echo "")
	fi
	base_ref=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || echo "origin/main")
	commit_closes=$(git log --format=%B "${base_ref}..HEAD" 2>/dev/null |
		grep -oiE '(clos(e|es|ed)|fix(es|ed)?|resolv(e|es|ed)) #[0-9]+' |
		grep -oE '[0-9]+' || true)
	exempt=$(printf '%s\n%s\n%s\n' "$self_pr" "$self_closes" "$commit_closes" | grep -E '^[0-9]+$' | sort -u || true)

	claims_done='complete|completed|landed|shipped|closed|done|fixed|merged|resolved|settled'
	# Deliberately excludes ambiguous words. "the remaining operations are frozen" sits
	# one clause away from "(PR #67)" and means something else entirely; a guard that
	# fires on that gets switched off within a week.
	claims_open='not started|unbuilt|outstanding|to come|next up|pending|in progress|in flight|blocked|stays open'

	for doc in $STATUS_DOCS; do
		[ -f "$doc" ] || continue

		# Expand "#98-#102" into each number it spans, then collect every #NNN.
		nums=$(
			sed -E 's/#([0-9]+)[-–—]#([0-9]+)/#\1 #\2 RANGE(\1,\2)/g' "$doc" |
				grep -oE '#[0-9]+|RANGE\([0-9]+,[0-9]+\)' |
				awk -F'[(,)]' '/^RANGE/ { for (i = $2; i <= $3; i++) print "#" i; next } { print }' |
				tr -d '#' | sort -un
		)

		for n in $nums; do
			# This change's own number, and the issues it closes. See the note
			# where `exempt` is built: without this, the check fails exactly the
			# PRs that follow the convention.
			if printf '%s\n' "$exempt" | grep -qxF "$n"; then continue; fi

			state=$(awk -F'\t' -v n="$n" '$1 == n { print $2; exit }' "$tmpdir/states")
			[ -n "$state" ] || continue

			while IFS= read -r line; do
				lower=$(printf '%s' "$line" | tr '[:upper:]' '[:lower:]')
				says_done=0; says_open=0
				printf '%s' "$lower" | grep -qE "$claims_done" && says_done=1
				printf '%s' "$lower" | grep -qE "$claims_open" && says_open=1
				[ $((says_done + says_open)) -eq 1 ] || continue

				if [ "$state" != "OPEN" ] && [ "$says_open" -eq 1 ]; then
					note "check-docs: $doc calls #$n outstanding, but it is $state:"
					note "            ${line#"${line%%[![:space:]]*}"}"
					fail=1
				elif [ "$state" = "OPEN" ] && [ "$says_done" -eq 1 ]; then
					note "check-docs: $doc calls #$n done, but it is still OPEN:"
					note "            ${line#"${line%%[![:space:]]*}"}"
					fail=1
				fi
			done <<-EOF
				$(grep -nE "#$n([^0-9]|\$)" "$doc" || true)
			EOF
		done
	done
fi

# ---------------------------------------------------------------------------
# 4. The canonical walkthrough reaches for the product, not for curl (#155).
# ---------------------------------------------------------------------------
# Parts B and C of the manual test plan are the §2.1 walkthrough — the agent's
# loop and the human's supervision — and they are what a first-time reader
# follows. Every `curl` in them was a capability with no command: the documented
# way to report a gate, record a review or undo a merge was to assemble an HTTP
# request by hand, which is a strange thing to ask of somebody evaluating a
# product whose whole argument is that the tools should already know.
#
# Part D onward is deliberately exempt. It is the trust-plane ramp — registering
# a webhook, posting a lockfile diff for admission, delivering a GitHub-shaped
# payload — and those are operator and integration surfaces that have no CLI
# verb by design. Exempting them by *naming* them is the point: a check that
# swallowed the whole file would stop meaning anything the first time Part D
# grew a curl nobody minded.
plan="docs/manual-test-plan.md"
if [ -f "$plan" ]; then
	walkthrough=$(awk '/^## Part B/{p=1} /^## Part D/{p=0} p' "$plan")
	if printf '%s\n' "$walkthrough" | grep -q 'curl'; then
		note "check-docs: the canonical walkthrough (Parts B–C of $plan) reaches for curl:"
		printf '%s\n' "$walkthrough" | grep -n 'curl' | sed 's/^/            /' >&2
		note ""
		note "            #155: a capability with no command is one whose documented"
		note "            spelling is an HTTP request assembled by hand. Add the command,"
		note "            or move the step to Part D and say why it belongs there."
		fail=1
	fi
fi

if [ "$fail" -ne 0 ]; then
	note ""
	note "Either the world moved and the document needs updating, or the claim was wrong"
	note "when it was written. Both are worth knowing; neither should reach main."
	exit 1
fi

echo "check-docs: paths, links and status claims in tracked markdown all hold."
