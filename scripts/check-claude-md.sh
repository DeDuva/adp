#!/bin/sh
# Fail if CLAUDE.md points at a path in this repository that no longer exists.
#
# CLAUDE.md tells an agent which files carry which invariant — server/test/require-db.ts,
# server/src/spec-coverage.test.ts, deploy/docker-compose.test.yml. A rename turns that
# from guidance into a wrong map, silently, and the cost is paid later by whoever trusts
# it. This is the same argument as ADP_REQUIRE_DB: guidance that has quietly stopped being
# true is worse than guidance that was never claimed.
#
# What it checks: every backticked token in CLAUDE.md that looks like a repo-relative path
# and whose first segment is a tracked top-level entry must itself be tracked. Tokens
# rooted anywhere else — /api/adp, ~/.config, https://…, another repository's layout — are
# references to things outside this tree and are left alone.
set -eu

cd "$(git rev-parse --show-toplevel)"

[ -f CLAUDE.md ] || {
	echo "check-claude-md: CLAUDE.md is missing from the repository root" >&2
	exit 1
}

tracked=$(git ls-files)
toplevel=$(printf '%s\n' "$tracked" | cut -d/ -f1 | sort -u)

refs=$(
	grep -o '`[^`]*`' CLAUDE.md |
		tr -d '`' |
		grep '/' |
		grep -v '[ 	<>*$=~()|]' |
		grep -v '://' |
		grep -v '^[/@-]' |
		sort -u
)

missing=0
for ref in $refs; do
	# Skip anything whose first segment is not a top-level entry of this repo: it is a
	# path in a sibling project, not a claim about this one.
	printf '%s\n' "$toplevel" | grep -qxF "${ref%%/*}" || continue

	clean=${ref%/}
	if printf '%s\n' "$tracked" |
		awk -v p="$clean" '$0 == p || index($0, p "/") == 1 { found = 1; exit } END { exit !found }'; then
		continue
	fi

	echo "check-claude-md: CLAUDE.md references a path that does not exist: $ref" >&2
	missing=1
done

if [ "$missing" -ne 0 ]; then
	echo "" >&2
	echo "Either the path moved and CLAUDE.md needs updating, or the reference was a typo." >&2
	exit 1
fi

echo "check-claude-md: every repository path in CLAUDE.md resolves."
