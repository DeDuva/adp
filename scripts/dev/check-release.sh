#!/usr/bin/env bash
# Fail when the version surfaces stop agreeing with each other.
#
# CHANGELOG.md states the rule: "the git tag, the GitHub release, the published image
# (ghcr.io/deduva/adp), and the served ADP-API-Version all move together". The rule was
# written; the enforcement covered exactly one edge of it. `release.yml` asserts the tag
# matches `server/src/api-version.ts`, and `api-version.test.ts` asserts api-version.ts
# matches `spec/openapi.yaml`. Nothing asserted anything else, and nothing at all
# asserted that a bump ever reached a tag.
#
# So both 0.4.0 and 0.5.0 were bumped in-tree, described in the CHANGELOG as
# "unreleased", and left there. On 2026-08-23 the repo served contract 0.5.0 from a tree
# whose only tag and only GitHub release was v0.3.0, whose Helm chart told operators to
# deploy appVersion 0.2.0, and whose four package.json files all still said 0.0.0 — the
# placeholder api-version.ts had itself been created to stop being. A consumer reading
# the release page and a consumer reading the response header got two different answers,
# and the guard that was supposed to make that impossible only watched the one edge that
# was never going to break.
#
# This checks every surface against `server/src/api-version.ts`, which is the source of
# truth because it is the one the server actually serves.
#
# The tag check needs the network. Per the standing invariant — a check that can skip
# itself is a check that can silently stop running — it skips loudly when `gh` is
# unavailable and becomes a hard failure under ADP_REQUIRE_GH=1, which CI sets.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

fail=0
note() { printf '%s\n' "$*" >&2; }
bad() {
	note "check-release: $*"
	fail=1
}

version=$(grep -oE 'export const API_VERSION = "[^"]+"' server/src/api-version.ts |
	grep -oE '"[^"]+"' | tr -d '"')

if [ -z "$version" ]; then
	note "check-release: could not read API_VERSION from server/src/api-version.ts."
	exit 1
fi

case $version in
0.0.0 | "")
	bad "api-version.ts serves '$version' — that is the placeholder it exists to replace."
	;;
esac

# ---------------------------------------------------------------------------
# 1. The published contract.
# ---------------------------------------------------------------------------
# api-version.test.ts already asserts this, but that test needs a built server and a
# vitest run. This script is cheap and runs in `make check` ahead of the suite, so a
# mismatch is reported in seconds rather than after a full build.
spec_version=$(awk '/^info:/{f=1;next} f&&/^  version:/{print $2;exit} /^[a-z]/&&!/^info:/{f=0}' spec/openapi.yaml)
[ "$spec_version" = "$version" ] ||
	bad "spec/openapi.yaml says $spec_version, api-version.ts says $version."

# ---------------------------------------------------------------------------
# 2. The chart an operator deploys.
# ---------------------------------------------------------------------------
# appVersion is what `helm install` reports and what the chart's own comment promises to
# track. It sat at 0.2.0 across two contract releases.
chart_app=$(grep -oE '^appVersion: *"?[^"]+"?' helm/adp/Chart.yaml | sed 's/^appVersion: *//; s/"//g')
[ "$chart_app" = "$version" ] ||
	bad "helm/adp/Chart.yaml appVersion is $chart_app, api-version.ts says $version."

# ---------------------------------------------------------------------------
# 3. The workspace packages.
# ---------------------------------------------------------------------------
# All five are `private: true` and none is published to npm, which is exactly why they
# were left at 0.0.0 and why that went unnoticed. They still land in the image, in
# `npm ls` output, and in anything that reads a manifest to report what is running.
#
# `recorder` is in this list since 2026-09-01 and was not before: it was added to the
# tree after this script was written, so it sat at 0.5.0 through the release that was
# *about* it while everything else moved. Adding a package here is part of adding a
# package to the repository — the whole point of this file is that no surface is
# checked by remembering.
for pkg in server cli runner adapters recorder; do
	pkg_version=$(grep -m1 -oE '"version": *"[^"]+"' "$pkg/package.json" |
		grep -oE '"[^"]+"$' | tr -d '"')
	[ "$pkg_version" = "$version" ] ||
		bad "$pkg/package.json is $pkg_version, api-version.ts says $version."

	# The lockfile carries the same version twice and npm rewrites both on install; if
	# they drift, the next `npm ci` produces a diff nobody asked for.
	lock_version=$(grep -m1 -oE '"version": *"[^"]+"' "$pkg/package-lock.json" |
		grep -oE '"[^"]+"$' | tr -d '"')
	[ "$lock_version" = "$version" ] ||
		bad "$pkg/package-lock.json is $lock_version, api-version.ts says $version."
done

# ---------------------------------------------------------------------------
# 3b. The published site.
# ---------------------------------------------------------------------------
# `docs/html/` is deployed straight from the tree by pages.yml on every push to main,
# so a version string there is a *published* version string — the first one a visitor
# reads, and the only one they read before deciding whether to clone.
#
# It went stale immediately and invisibly. On 2026-09-01 all three pages said
# "Spec 0.5.0" while the server served 0.6.0, and both gates that could have caught it
# passed: this script did not look at docs/html at all, and `make site` drives every
# page in a real browser without reading a word of their content.
#
# Matched loosely on purpose. The masthead is `Spec X.Y.Z · MIT` on each page and the
# prose is `<code>X.Y.Z</code>, served as <code>ADP-API-Version</code>`; pinning the
# exact markup would turn a restyle into a release failure, so this asks the weaker and
# more durable question: does any version-shaped string on a published page disagree
# with what the server serves?
site_pages=$(git ls-files 'docs/html/*.html' 'docs/html/**/*.html' 2>/dev/null || true)
for page in $site_pages; do
	# Every X.Y.Z that is introduced as a spec/contract version, in either spelling.
	claimed=$(grep -oE '(Spec|spec|contract|currently)[^0-9]{0,40}[0-9]+\.[0-9]+\.[0-9]+' "$page" |
		grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | sort -u)
	for c in $claimed; do
		[ "$c" = "$version" ] ||
			bad "$page claims contract $c, api-version.ts says $version."
	done
done

# ---------------------------------------------------------------------------
# 3c. The image the Compose path deploys.
# ---------------------------------------------------------------------------
# docs/self-hosting.md §3 is one of two supported deployment paths, and the comment
# above this line promises "the released image by default". It defaulted to v0.3.0
# through two whole releases, so an operator who ran `docker compose up -d` without
# `--build` got a server three contract versions behind every document describing it.
#
# The chart's appVersion was checked from the day this script existed; the compose
# file's tag was the other half of the same claim and was never checked.
compose_tag=$(grep -oE 'ADP_IMAGE:-ghcr\.io/deduva/adp:v?[0-9]+\.[0-9]+\.[0-9]+' deploy/docker-compose.yml |
	grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)
if [ -z "$compose_tag" ]; then
	bad "deploy/docker-compose.yml no longer pins a versioned ADP_IMAGE default."
	note "            That default is what an operator gets from 'docker compose up -d'."
else
	[ "$compose_tag" = "$version" ] ||
		bad "deploy/docker-compose.yml deploys v$compose_tag, api-version.ts says $version."
fi

# ---------------------------------------------------------------------------
# 4. The CHANGELOG entry.
# ---------------------------------------------------------------------------
# `release.yml` builds the GitHub release notes by extracting the section between
# `## <tag>` and the next `## v`. A missing or misplaced heading does not fail the
# release — it publishes an empty one.
top=$(grep -m1 -oE '^## v[0-9]+\.[0-9]+\.[0-9]+' CHANGELOG.md | sed 's/^## v//')
[ -n "$top" ] || bad "CHANGELOG.md has no '## vX.Y.Z' heading."

if [ -n "$top" ] && [ "$top" != "$version" ]; then
	bad "CHANGELOG.md's newest entry is v$top, api-version.ts says $version."
	note "            The newest entry must be the version being served, or the release"
	note "            workflow extracts notes for the wrong one."
fi

# An entry may say "unreleased" — that is the correct state between a contract bump and
# its tag. What it may not do is say "unreleased" for a version that has already been
# tagged, which is how 0.4.0's entry came to describe shipped code as pending.
heading=$(grep -m1 -E '^## v[0-9]+\.[0-9]+\.[0-9]+' CHANGELOG.md)
unreleased=0
case $heading in
*unreleased* | *Unreleased*) unreleased=1 ;;
esac

# ---------------------------------------------------------------------------
# 5. The tag, and whether the served version ever reached one.
# ---------------------------------------------------------------------------
gh_ok=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
	gh_ok=1
fi

if [ "$gh_ok" -eq 0 ]; then
	if [ "${ADP_REQUIRE_GH:-0}" = "1" ]; then
		note "check-release: ADP_REQUIRE_GH=1 but gh is unavailable or unauthenticated."
		note "               The tag check is the one that catches a version that never"
		note "               shipped; CI must not pass without it."
		exit 1
	fi
	note "check-release: skipping the tag check (no authenticated gh)."
	note "               Set ADP_REQUIRE_GH=1 to make this a failure, as CI does."
else
	tagged=0
	if gh api "repos/{owner}/{repo}/git/ref/tags/v$version" >/dev/null 2>&1; then
		tagged=1
	fi

	# Only one of the four states is a lie, and it is the one that shipped: a tag
	# exists, so the image and the release page are public, while the tree still
	# describes that version as pending. Whoever reads the CHANGELOG is told the
	# opposite of what the release page says.
	if [ "$tagged" -eq 1 ] && [ "$unreleased" -eq 1 ]; then
		bad "v$version is tagged on GitHub but CHANGELOG.md still calls it unreleased."
	fi

	# The other three are legitimate states of an ongoing release, not errors — but the
	# reason 0.4.0 and 0.5.0 drifted is that nobody was ever *told*. So they report.
	#
	# Dating the entry before the tag is this repo's actual convention: v0.3.0's dated
	# heading was committed 2026-08-13 (#119) and the tag was pushed 2026-08-14, because
	# release.yml builds the release notes by reading the heading it is about to tag.
	# Failing here would fail the very PR that prepares a release.
	if [ "$tagged" -eq 0 ] && [ "$unreleased" -eq 0 ]; then
		note "check-release: v$version is dated in CHANGELOG.md but not yet tagged."
		note "               Finish the release after this merges:"
		note "                 git tag v$version && git push origin v$version"
	fi

	if [ "$tagged" -eq 0 ] && [ "$unreleased" -eq 1 ]; then
		latest=$(gh api "repos/{owner}/{repo}/releases/latest" -q .tag_name 2>/dev/null || echo "")
		note "check-release: serving $version, which is unreleased${latest:+ — newest release is $latest}."
		note "               That is normal mid-development and fatal if it is forgotten:"
		note "               0.4.0 and 0.5.0 both sat in exactly this state until 2026-08-23,"
		note "               while the newest release said 0.3.0."
		# The ordering, said here rather than only in this file's comments. On
		# 2026-09-02 v0.6.0 was tagged while its heading still read
		# "unreleased"; release.yml re-runs this script before publishing, so
		# the tag existed with no image and no release page behind it, and the
		# recovery was a second pull request and a moved tag. The note above
		# told the reader the state was fatal if forgotten. It did not tell
		# them which order the two steps go in, which is the part that bites.
		note "               Date the heading in a pull request FIRST, then tag what lands:"
		note "                 ## v$version — YYYY-MM-DD"
		note "               release.yml reads the heading at the commit it tags, so tagging"
		note "               ahead of the date publishes nothing and fails the release run."
	fi
fi

if [ "$fail" -ne 0 ]; then
	note ""
	note "check-release: the version surfaces disagree. server/src/api-version.ts is the"
	note "               source of truth — it is what the server serves on every response."
	exit 1
fi

printf 'check-release: %s consistent across spec, chart, packages, site, compose and CHANGELOG.\n' "$version"
