#!/usr/bin/env bash
# Does `make local` actually produce an instance gh will talk to, and does it
# survive being stopped?
#
#   bash scripts/dev/local-smoke.sh
#
# #158's two exit criteria, checked rather than asserted in prose:
#
#   1. One documented command produces a local instance `gh` will talk to.
#   2. The first-contact journey reaches a landed, evidenced change on a
#      **persistent** local instance.
#
# The second word is the one that needs a test. `make demo` already proves the
# journey works against an ephemeral instance and CI already runs it — what is
# new here is that the instance is still there afterwards, with the change and
# its signed evidence intact, which is exactly the property a script can regress
# silently. So this stops the instance, starts it again, and reads the evidence
# bundle back from the restarted one.
#
# Deliberately not part of `make check`: it binds fixed ports and a named
# docker volume, so it would collide with a developer's own local instance and
# with a second worktree running the suite. It is its own CI job, run on every
# push, which is the same bargain `make demo` strikes.
set -euo pipefail
cd "$(dirname "$0")/../.."

GH_VERSION="${GH_VERSION:-2.63.0}"
c_g=$'\033[32m'; c_r=$'\033[31m'; c_b=$'\033[1m'; c_0=$'\033[0m'
step() { printf '\n%s▸ %s%s\n' "$c_b" "$*" "$c_0"; }
pass() { printf '  %s✓%s %s\n' "$c_g" "$c_0" "$*"; }
fail() { printf '\n%slocal-smoke failed:%s %s\n' "$c_r" "$c_0" "$*" >&2; exit 1; }

WORKDIR="$(mktemp -d -t adp-local-smoke-XXXXXX)"
cleanup() {
  local code=$?
  rm -rf "$WORKDIR"
  # Always destroy: this script's instance is a test fixture, and leaving a
  # named volume and two daemons behind on a failure is the leak every other
  # harness here has a verify-clean step for.
  bash scripts/dev/local.sh destroy >/dev/null 2>&1 || true
  exit $code
}
trap cleanup EXIT

# A pre-existing instance would make every assertion below meaningless — it
# would be testing that one, on its ports, with its data.
bash scripts/dev/local.sh destroy >/dev/null 2>&1 || true

GH_CACHE="${GH_CACHE_DIR:-$HOME/.cache/adp-conformance-gh}/${GH_VERSION}"
GH_BIN="$GH_CACHE/gh_${GH_VERSION}_linux_amd64/bin/gh"
if [ ! -x "$GH_BIN" ]; then
  mkdir -p "$GH_CACHE"
  curl -sL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
    -o "$WORKDIR/gh.tar.gz" || fail "could not download gh"
  tar -xzf "$WORKDIR/gh.tar.gz" -C "$GH_CACHE"
fi

step "1 — one command brings it up"
bash scripts/dev/local.sh up >"$WORKDIR/up.log" 2>&1 || { cat "$WORKDIR/up.log"; fail "make local did not come up"; }
[ -f .adp-local/env ] || fail "no .adp-local/env was written"
set -a; . ./.adp-local/env; set +a
[ -n "${ADP_TOKEN:-}" ] && [ -n "${GH_HOST:-}" ] && [ -n "${SSL_CERT_FILE:-}" ] || fail ".adp-local/env is missing what a caller needs"
pass "up, and .adp-local/env carries the token, host and certificate path"

# The certificate is the whole point: `gh` refuses plain HTTP for any host but
# github.com, so this is the assertion that separates a local instance from a
# local port.
gh_() { GH_TOKEN= GITHUB_TOKEN= "$GH_BIN" "$@"; }
gh_ auth status 2>&1 | grep -q "Logged in to ${GH_HOST}" || fail "gh will not talk to the instance over TLS"
pass "gh talks to it over TLS with nothing installed into a trust store"

step "2 — the first-contact journey, on that instance"
OWNER="$ADP_ORG"; REPO="smoke"
# The REST route, not `gh repo create` — the same call acceptance, conformance
# and the demo all make. `gh repo create owner/name` resolves the owner through
# `GET /api/v3/users/{owner}` first, which ADP does not serve, so repo creation
# is the one step of the walkthrough that is not a `gh` command (README's
# compatibility table says so).
curl -sf -X POST "https://${GH_HOST}/api/v3/repos/${OWNER}" --cacert "$SSL_CERT_FILE" \
  -H "Authorization: Bearer ${ADP_TOKEN}" -H "Content-Type: application/json" \
  -d "{\"name\":\"${REPO}\"}" -o /dev/null || fail "could not create the repo"
pass "repository ${OWNER}/${REPO} created"

CLONE="$WORKDIR/clone"
# `-c credential.helper=` because the URL already carries the token and a test
# has no business writing to the developer's credential store — which, on a
# machine whose helper is slow or interactive, is also where this would hang.
git -c credential.helper= clone "https://x-access-token:${ADP_TOKEN}@${GH_HOST}/${OWNER}/${REPO}.git" "$CLONE" >/dev/null 2>&1 \
  || fail "clone over https failed (GIT_SSL_CAINFO is what makes this work)"
( cd "$CLONE"
  git checkout -B main >/dev/null 2>&1
  git config user.email smoke@example.com; git config user.name smoke
  echo "# smoke" > README.md
  printf 'gates:\n  - test\nland:\n  require: []\n' > adp.yaml
  git add . && git commit -q -m "initial commit"
  git -c credential.helper= push -q origin main
  git checkout -q -b feature
  echo "described." >> README.md
  git commit -q -am "describe it"
  git -c credential.helper= push -q origin feature ) || fail "push failed"
HEAD_SHA=$(git -C "$CLONE" rev-parse feature)
pass "cloned, pushed — plain git over the same certificate"

gh_ pr create --repo "${GH_HOST}/${OWNER}/${REPO}" --base main --head feature \
  --title "Describe it" --body "." >/dev/null || fail "gh pr create failed"
pass "gh pr create"

# gates_green is the default floor (#174) and adp.yaml names a gate, so this
# merge must be refused before the gate reports — the beat that makes the
# landed change below evidence of something.
REFUSAL=$(gh_ pr merge 1 --repo "${GH_HOST}/${OWNER}/${REPO}" --merge 2>&1 || true)
grep -q 'gates_green' <<<"$REFUSAL" || fail "the land policy did not refuse an ungated merge: $REFUSAL"
pass "refused before any gate reported"

curl -sf -X POST "https://${GH_HOST}/api/v3/repos/${OWNER}/${REPO}/gates" \
  --cacert "$SSL_CERT_FILE" \
  -H "Authorization: Bearer ${ADP_TOKEN}" -H "Content-Type: application/json" \
  -d "{\"git_sha\":\"${HEAD_SHA}\",\"name\":\"test\",\"status\":\"success\",\"summary\":\"12 passed\"}" \
  -o /dev/null || fail "gate report failed"
gh_ pr merge 1 --repo "${GH_HOST}/${OWNER}/${REPO}" --merge >/dev/null || fail "gh pr merge failed"
pass "gate reported, change landed"

step "3 — the instance survives being stopped"
bash scripts/dev/local.sh down >"$WORKDIR/down.log" 2>&1 || { cat "$WORKDIR/down.log"; fail "local down failed"; }
curl -sf --max-time 3 --cacert "$SSL_CERT_FILE" "https://${GH_HOST}/healthz" >/dev/null 2>&1 \
  && fail "the instance is still answering after 'make local-down'"
pass "stopped — nothing is answering"

bash scripts/dev/local.sh up >"$WORKDIR/up2.log" 2>&1 || { cat "$WORKDIR/up2.log"; fail "local up did not come back"; }
# Same env file, so the same signing key and the same token: an instance that
# minted new ones would have orphaned every signature already landed on it.
set -a; . ./.adp-local/env; set +a
grep -q 'reusing this instance' "$WORKDIR/up2.log" || fail "the restart did not reuse this instance's keys"
pass "back up, reusing the same keys, certificate and token"

BUNDLE=$(curl -sf --cacert "$SSL_CERT_FILE" \
  "https://${GH_HOST}/api/adp/repos/${OWNER}/${REPO}/evidence/${HEAD_SHA}" \
  -H "Authorization: Bearer ${ADP_TOKEN}") || fail "could not read the evidence bundle after the restart"
for field in '"signature"' '"provenance"' '"test"'; do
  grep -q "$field" <<<"$BUNDLE" || fail "the evidence bundle lost ${field} across the restart: $BUNDLE"
done
pass "the landed change and its signed evidence are still there"

step "4 — destroy removes the data"
bash scripts/dev/local.sh destroy >"$WORKDIR/destroy.log" 2>&1 || { cat "$WORKDIR/destroy.log"; fail "destroy failed"; }
[ -d .adp-local ] && fail ".adp-local survived destroy"
docker volume ls --format '{{.Name}}' | grep -q '^adp-local_pgdata$' && fail "the database volume survived destroy"
pass "state and volume gone"

printf '\n%s== local-smoke: a persistent local instance, reached by gh, surviving a restart ==%s\n' "$c_g" "$c_0"
