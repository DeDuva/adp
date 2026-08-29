#!/usr/bin/env bash
# The M1b′ gate: the definition of done minus
# evidence/undo passes with a real, unmodified `gh` — gh issue view / pr
# create / pr view / pr merge against the server." This script is that gate.
#
# It downloads a pinned `gh` release (never the one on PATH, so this is
# reproducible regardless of what's installed on the runner), fronts the
# plain-HTTP ADP server with a throwaway self-signed TLS proxy (`gh` refuses
# plain HTTP for any non-github.com host), and drives the real binary through
# the four gate commands against a live server backed by a real Postgres.
#
# Not implemented: recording and replaying actual HTTP exchanges captured
# against production github.com. That needs a real GitHub token in CI and
# is a larger investment than this gate calls for; what's here is the
# substance of the gate as documented — real unmodified `gh`, not a
# hand-rolled approximation of its queries.
set -euo pipefail
cd "$(dirname "$0")/.."

GH_VERSION="${GH_VERSION:-2.63.0}"
# Port helpers, sourced early because the picks below are the first thing this
# script does. Functions only, nothing named `fail` — see the file's own header.
#
# Not guarded with `[ -f ... ] &&` the way config.sh is below: that guard is
# there because config.sh supplies a *default* this script can live without,
# whereas a harness that cannot choose a port has nothing to fall back to. A
# missing file should say so on line one rather than three minutes in.
# shellcheck source=../scripts/dev/ports.sh
. ../scripts/dev/ports.sh

# Randomized rather than fixed: avoids colliding with a leftover process from
# a prior interrupted run (each CI job gets a fresh container, so this only
# matters for repeated local runs during development).
#
# Picked BELOW the kernel's ephemeral floor as of the port-race fix. The old
# ranges (20000-39999 and 40000-59999) overlapped the pool every outbound
# connection draws from — the TLS proxy's completely — so `listen()` lost a
# race to an unrelated socket often enough to cost three full runs. See
# scripts/dev/ports.sh.
PORT="${ADP_CONFORMANCE_PORT:-$(adp_pick_port 20000)}"
TLS_PORT="${ADP_CONFORMANCE_TLS_PORT:-$(adp_pick_port 20000)}"
[ -n "$PORT" ] && [ -n "$TLS_PORT" ] || { echo "CONFORMANCE FAIL: could not find free ports" >&2; exit 1; }
WORKDIR="$(mktemp -d)"
GH_HOST="localhost:${TLS_PORT}"

SELF_PGID="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"

# `kill $SERVER_PID` reaches only the `npx` wrapper. tsx then spawns a child
# node process which survives, keeps the port bound, and gets reparented to
# init — a stray ADP server that outlives the run and answers on a port
# something else expects to own later. That is the phantom-404 failure mode in
# docs/test-environment-automation.md (finding 3) arriving by a second route,
# and it was caught by scripts/dev/verify-clean.sh after a real run.
#
# So signal the whole process group rather than the one pid. The group is read
# off the process itself, so it still works once children have been reparented,
# and it is compared against this script's own group first — signalling that
# would kill the script mid-cleanup.
kill_tree() {
  local pid="${1:-}" pgid
  [ -n "$pid" ] || return 0
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  if [ -n "$pgid" ] && [ "$pgid" != "$SELF_PGID" ]; then
    kill -TERM -- "-$pgid" 2>/dev/null || true
    return 0
  fi
  # Shares our group (no separate group was created): walk the tree instead,
  # deepest first, so no child is orphaned by its parent dying ahead of it.
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill -TERM "$pid" 2>/dev/null || true
}

cleanup() {
  kill_tree "${SERVER_PID:-}"
  kill_tree "${PROXY_PID:-}"
  [ -n "${DEBUG_KEEP_WORKDIR:-}" ] || rm -rf "$WORKDIR"
}
trap cleanup EXIT

fail() {
  echo "CONFORMANCE FAIL: $*" >&2
  exit 1
}

echo "== conformance: workdir $WORKDIR, gh $GH_VERSION, GH_HOST $GH_HOST =="

# --- pinned gh binary ------------------------------------------------------
GH_CACHE="${GH_CACHE_DIR:-$HOME/.cache/adp-conformance-gh}/${GH_VERSION}"
GH_BIN="$GH_CACHE/gh_${GH_VERSION}_linux_amd64/bin/gh"
if [ ! -x "$GH_BIN" ]; then
  echo "-- fetching gh $GH_VERSION --"
  mkdir -p "$GH_CACHE"
  curl -sL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
    -o "$WORKDIR/gh.tar.gz"
  tar -xzf "$WORKDIR/gh.tar.gz" -C "$GH_CACHE"
fi
"$GH_BIN" --version

# --- throwaway TLS cert + proxy --------------------------------------------
openssl req -x509 -newkey rsa:2048 -keyout "$WORKDIR/key.pem" -out "$WORKDIR/cert.pem" \
  -days 1 -nodes -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost" \
  >/dev/null 2>&1

node conformance/tls-proxy.mjs "$WORKDIR/cert.pem" "$WORKDIR/key.pem" "$TLS_PORT" "$PORT" \
  > "$WORKDIR/tls-proxy.log" 2>&1 &
PROXY_PID=$!

# Wait for it, the same way the server below is waited for. Without this, a
# proxy that died at startup was only discovered when `gh` failed to connect
# several minutes later, reported as `connection refused` against a port whose
# owner had never existed — a symptom that names neither the process that
# failed nor the reason.
#
# Its own startup log line rather than a port probe: the line comes from the
# listen callback, so it proves this proxy is serving rather than that
# something is (see scripts/dev/ports.sh).
adp_wait_for_log_line "$WORKDIR/tls-proxy.log" '^tls-proxy: ' "$PROXY_PID" || {
  cat "$WORKDIR/tls-proxy.log"
  fail "TLS proxy never came up on :$TLS_PORT"
}

# --- ADP server -------------------------------------------------------------
# One canonical local DSN, shared with scripts/dev/* — these had drifted apart
# (docs/test-environment-automation.md, finding 5). config.sh, not lib.sh:
# constants only, so it cannot override this script's own `fail()`. Sourced
# defensively so this keeps working from a partial checkout.
# shellcheck source=../scripts/dev/config.sh
[ -f ../scripts/dev/config.sh ] && . ../scripts/dev/config.sh
export DATABASE_URL="${DATABASE_URL:-${ADP_DEFAULT_DATABASE_URL:-postgres://adp:adp@localhost:5432/adp}}"
export GIT_ROOT="$WORKDIR/git"
export SIGNING_KEY="conformance-test-key"
export MIRROR_CREDENTIAL_KEY="conformance-test-mirror-key"
export PUBLIC_URL="http://localhost:${PORT}"
export PORT
mkdir -p "$GIT_ROOT"

npm run migrate >/dev/null

npx tsx src/main.ts > "$WORKDIR/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 30); do
  kill -0 "$SERVER_PID" 2>/dev/null || { cat "$WORKDIR/server.log"; fail "server process exited before becoming healthy"; }
  curl -sf "http://localhost:${PORT}/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "http://localhost:${PORT}/healthz" >/dev/null || { cat "$WORKDIR/server.log"; fail "server never became healthy"; }

# --- fixture repo -----------------------------------------------------------
OWNER="conformance-$$"
TOKEN=$(npx tsx src/bootstrap.ts "conformance-actor-$$" --org "$OWNER" 2>&1 | grep '^Token:' | awk '{print $2}')
[ -n "$TOKEN" ] || fail "bootstrap didn't mint a token"
# A second principal in the same org. `one_approval` is author-independent
# (#121), so the actor that opens the PR cannot be the one that approves it —
# and this suite has to mint the reviewer the same way a real deployment
# would, rather than reaching into the database.
REVIEWER_TOKEN=$(npx tsx src/bootstrap.ts "conformance-reviewer-$$" --org "$OWNER" 2>&1 | grep '^Token:' | awk '{print $2}')
[ -n "$REVIEWER_TOKEN" ] || fail "bootstrap didn't mint a reviewer token"

curl -sf -X POST "http://localhost:${PORT}/api/v3/repos/${OWNER}" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{"name":"widget"}' >/dev/null || fail "repo create failed"

CLONE_DIR="$WORKDIR/clone"
git clone "http://x-access-token:${TOKEN}@localhost:${PORT}/${OWNER}/widget.git" "$CLONE_DIR" >/dev/null 2>&1
(
  cd "$CLONE_DIR"
  git checkout -B main >/dev/null 2>&1
  git config user.email "conformance@example.com"
  git config user.name "Conformance"
  echo hi > README.md
  git add . && git commit -m init >/dev/null
  git push origin main >/dev/null 2>&1
  git checkout -b feature >/dev/null 2>&1
  echo more >> README.md
  git commit -am "feature commit" >/dev/null
  git push origin feature >/dev/null 2>&1
)

# --- the gate: gh issue view / pr create / pr view / pr merge --------------
export GH_ENTERPRISE_TOKEN="$TOKEN"
export SSL_CERT_FILE="$WORKDIR/cert.pem"
REPO="${GH_HOST}/${OWNER}/widget"

echo "-- gh issue create --"
"$GH_BIN" issue create --repo "$REPO" --title "conformance issue" --body "body" \
  || fail "gh issue create"

echo "-- gh issue view --"
ISSUE_OUT=$("$GH_BIN" issue view 1 --repo "$REPO") || fail "gh issue view"
echo "$ISSUE_OUT" | grep -q "conformance issue" || fail "gh issue view: title missing from output"

echo "-- gh pr create --"
"$GH_BIN" pr create --repo "$REPO" --base main --head feature --title "conformance pr" --body "body" \
  || fail "gh pr create"

echo "-- gh pr view --"
PR_OUT=$("$GH_BIN" pr view 1 --repo "$REPO") || fail "gh pr view"
echo "$PR_OUT" | grep -q "conformance pr" || fail "gh pr view: title missing from output"

# The default instance land-policy floor (LAND_POLICY_FLOOR, config.ts) now
# requires one_approval — confirm an unreviewed PR is genuinely refused,
# then approve it and confirm the merge succeeds, same as a real workflow.
PRE_APPROVAL_MERGE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
  "http://localhost:${PORT}/api/v3/repos/${OWNER}/widget/pulls/1/merge" \
  -H "Authorization: Bearer ${TOKEN}")
[ "$PRE_APPROVAL_MERGE_STATUS" = "422" ] || fail "expected land policy to refuse an unreviewed merge (422), got $PRE_APPROVAL_MERGE_STATUS"

# The author approves its own PR. GitHub refuses this outright; ADP records
# the review and refuses the *merge* (#121), which is the same guarantee
# reached one step later. This assertion is why the reviewer above exists —
# before it, this suite proved a merge that self-approval had unblocked.
curl -sf -X POST "http://localhost:${PORT}/api/v3/repos/${OWNER}/widget/pulls/1/reviews" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{"state":"approved","body":"lgtm, me"}' >/dev/null \
  || fail "self-approving review failed"
SELF_APPROVAL_MERGE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
  "http://localhost:${PORT}/api/v3/repos/${OWNER}/widget/pulls/1/merge" \
  -H "Authorization: Bearer ${TOKEN}")
[ "$SELF_APPROVAL_MERGE_STATUS" = "422" ] || fail "expected land policy to refuse a self-approved merge (422), got $SELF_APPROVAL_MERGE_STATUS"

curl -sf -X POST "http://localhost:${PORT}/api/v3/repos/${OWNER}/widget/pulls/1/reviews" \
  -H "Authorization: Bearer ${REVIEWER_TOKEN}" -H "Content-Type: application/json" \
  -d '{"state":"approved","body":"looks good"}' >/dev/null \
  || fail "approving review failed"

echo "-- gh pr merge --"
"$GH_BIN" pr merge 1 --repo "$REPO" --merge || fail "gh pr merge"

# merge_method defaults to "merge" — main lands on a real merge commit, so
# this checks the feature commit is reachable from main, not that main *is*
# the feature head (the merge-method-fidelity item).
MERGED_LOG=$(git --git-dir="${GIT_ROOT}/${OWNER}/widget.git" log --oneline main)
echo "$MERGED_LOG" | grep -q "feature commit" || fail "pr merge did not land the feature commit on main server-side"

echo "== conformance: all gate commands passed against real, unmodified gh ${GH_VERSION} =="
