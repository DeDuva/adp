#!/usr/bin/env bash
# The M1b′ gate (docs/pragmatic_mvp.md): "definition of done §2.1 minus
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
# Randomized rather than fixed: avoids colliding with a leftover process from
# a prior interrupted run (each CI job gets a fresh container, so this only
# matters for repeated local runs during development).
PORT="${ADP_CONFORMANCE_PORT:-$((20000 + RANDOM % 20000))}"
TLS_PORT="${ADP_CONFORMANCE_TLS_PORT:-$((40000 + RANDOM % 20000))}"
WORKDIR="$(mktemp -d)"
GH_HOST="localhost:${TLS_PORT}"

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "${PROXY_PID:-}" ] && kill "$PROXY_PID" 2>/dev/null || true
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

# --- ADP server -------------------------------------------------------------
export DATABASE_URL="${DATABASE_URL:-postgres://adp:adp@localhost:5432/adp}"
export GIT_ROOT="$WORKDIR/git"
export SIGNING_KEY="conformance-test-key"
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
TOKEN=$(npx tsx src/bootstrap.ts "conformance-actor-$$" 2>&1 | grep '^Token:' | awk '{print $2}')
[ -n "$TOKEN" ] || fail "bootstrap didn't mint a token"

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

echo "-- gh pr merge --"
"$GH_BIN" pr merge 1 --repo "$REPO" --merge || fail "gh pr merge"

MERGED_LOG=$(git --git-dir="${GIT_ROOT}/${OWNER}/widget.git" log --oneline main)
echo "$MERGED_LOG" | grep -q "feature commit" || fail "pr merge didn't fast-forward main server-side"

echo "== conformance: all gate commands passed against real, unmodified gh ${GH_VERSION} =="
