#!/usr/bin/env bash
# The test drive: land a policy-compliant change, then look at its evidence.
#
# `make test-all` proves the system works. It is not a product demo — it runs
# every tier, asserts hundreds of things a visitor did not ask about, and prints
# nothing they came for. This does the opposite: one narrated pass through the
# thing ADP is actually for, ending at the artifact that is the whole point —
# a signed bundle binding a landed change to the evidence that it was checked.
#
# The success state, stated so it can be judged: you used ordinary git and an
# unmodified `gh` to land a change, watched the server refuse that same change
# while it lacked evidence, and then read the signed record of why it was
# allowed.
#
# Everything is ephemeral. Postgres runs in a container on a random port, the
# server and its TLS proxy are children of this script, and the git repos live
# in a temp directory. Nothing is installed, no account is created, and the
# cleanup trap runs on every exit path.
#
#   make demo                  # run it, then wait so you can poke around
#   ADP_DEMO_NO_WAIT=1 make demo   # run it and tear down immediately (CI)
#
# The setup deliberately mirrors server/acceptance/run.sh rather than inventing
# its own: that script's port picking, process-group kill and log-line readiness
# checks each exist because something failed in a way that cost a debugging
# session, and a demo that reimplemented them would reacquire the same bugs.
set -euo pipefail
cd "$(dirname "$0")/../.."

GH_VERSION="${GH_VERSION:-2.63.0}"
# shellcheck source=scripts/dev/ports.sh
. scripts/dev/ports.sh

c_dim=$'\033[2m'; c_b=$'\033[1m'; c_g=$'\033[32m'; c_c=$'\033[36m'; c_y=$'\033[33m'; c_r=$'\033[31m'; c_0=$'\033[0m'
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s▸ %s%s\n' "$c_b" "$*" "$c_0"; }
ok()   { printf '  %s✓%s %s\n' "$c_g" "$c_0" "$*"; }
info() { printf '  %s%s%s\n' "$c_dim" "$*" "$c_0"; }
die()  { printf '\n%sdemo failed:%s %s\n' "$c_r" "$c_0" "$*" >&2; exit 1; }

WORKDIR="$(mktemp -d -t adp-demo-XXXXXX)"
SERVER_PID=""; PROXY_PID=""; STARTED_STACK=0
SELF_PGID="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"

# Signal the process group: npx/tsx spawn children that survive a plain kill
# and keep the port bound.
kill_tree() {
  local pid="${1:-}" pgid
  [ -n "$pid" ] || return 0
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  if [ -n "$pgid" ] && [ "$pgid" != "$SELF_PGID" ]; then
    kill -TERM -- "-$pgid" 2>/dev/null || true
  else
    kill -TERM "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  printf '\n%scleaning up%s\n' "$c_dim" "$c_0"
  kill_tree "$PROXY_PID"; kill_tree "$SERVER_PID"
  wait "$PROXY_PID" "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORKDIR"
  # Only tear down Postgres if this script started it. Someone who already had
  # `make up` running keeps their stack.
  if [ "$STARTED_STACK" = "1" ]; then
    bash scripts/dev/down.sh >/dev/null 2>&1 || true
    info "ephemeral Postgres removed"
  else
    info "left your existing stack up (this script did not start it)"
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
say ""
say "${c_b}ADP — the agent-native forge${c_0}"
say "${c_dim}A five-minute test drive. Nothing is installed; everything is torn down at the end.${c_0}"

step "Bringing up an ephemeral instance"

command -v docker >/dev/null 2>&1 || die "docker is required (it runs the throwaway Postgres). See 'make doctor'."
command -v node   >/dev/null 2>&1 || die "node 22+ is required. See 'make doctor'."

if [ -f .env.test ]; then
  info "reusing the stack you already have up"
else
  info "starting a throwaway PostgreSQL (random port, tmpfs, no restart policy)"
  bash scripts/dev/up.sh >"$WORKDIR/up.log" 2>&1 || { cat "$WORKDIR/up.log"; die "could not start Postgres"; }
  STARTED_STACK=1
fi
set -a; . ./.env.test; set +a
[ -n "${DATABASE_URL:-}" ] || die ".env.test did not define DATABASE_URL"
ok "PostgreSQL up"

PORT="$(adp_pick_port 20000)"
TLS_PORT="$(adp_pick_port 20000)"
[ -n "$PORT" ] && [ -n "$TLS_PORT" ] || die "could not find free ports"

# gh is pinned and cached: the demo asserts compatibility with a *specific*
# real binary, and re-downloading it on every run would be the slowest step.
GH_CACHE="${GH_CACHE_DIR:-$HOME/.cache/adp-conformance-gh}/${GH_VERSION}"
GH_BIN="$GH_CACHE/gh_${GH_VERSION}_linux_amd64/bin/gh"
if [ ! -x "$GH_BIN" ]; then
  info "fetching the real gh $GH_VERSION (cached for next time)"
  mkdir -p "$GH_CACHE"
  curl -sL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
    -o "$WORKDIR/gh.tar.gz" || die "could not download gh"
  tar -xzf "$WORKDIR/gh.tar.gz" -C "$GH_CACHE"
fi
ok "gh $("$GH_BIN" --version | head -1 | awk '{print $3}') — the real binary, unmodified"

export GIT_ROOT="$WORKDIR/git"
export SIGNING_KEY="demo-$(openssl rand -hex 8)"
export MIRROR_CREDENTIAL_KEY="demo-$(openssl rand -hex 8)"
export PUBLIC_URL="http://localhost:${PORT}"
export PORT
mkdir -p "$GIT_ROOT"

( cd server && npm run migrate ) >"$WORKDIR/migrate.log" 2>&1 || { tail -20 "$WORKDIR/migrate.log"; die "migrations failed"; }
( cd server && npx tsx src/main.ts ) >"$WORKDIR/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do
  kill -0 "$SERVER_PID" 2>/dev/null || { tail -20 "$WORKDIR/server.log"; die "the server exited before it became healthy"; }
  curl -sf "http://localhost:${PORT}/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "http://localhost:${PORT}/healthz" >/dev/null || { tail -20 "$WORKDIR/server.log"; die "the server never became healthy"; }
ok "ADP serving on :$PORT"

# gh refuses plain HTTP for any non-github.com host, so the demo terminates TLS
# in front of the server with a throwaway self-signed cert.
openssl req -x509 -newkey rsa:2048 -keyout "$WORKDIR/key.pem" -out "$WORKDIR/cert.pem" \
  -days 1 -nodes -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost" >/dev/null 2>&1
( cd server && node conformance/tls-proxy.mjs "$WORKDIR/cert.pem" "$WORKDIR/key.pem" "$TLS_PORT" "$PORT" ) \
  >"$WORKDIR/tls-proxy.log" 2>&1 &
PROXY_PID=$!
# Wait for the proxy's own startup line rather than probing the port: the line
# proves this process is serving, where an open port only proves something is.
adp_wait_for_log_line "$WORKDIR/tls-proxy.log" '^tls-proxy: ' "$PROXY_PID" \
  || { cat "$WORKDIR/tls-proxy.log"; die "the TLS proxy never came up"; }
ok "TLS on :$TLS_PORT, so gh will talk to it"

OWNER="acme"; REPO="widget"
GH_HOST="localhost:${TLS_PORT}"
GH_REPO="${GH_HOST}/${OWNER}/${REPO}"
TOKEN=$( cd server && npx tsx src/bootstrap.ts "demo-agent" --org "$OWNER" 2>&1 | grep '^Token:' | awk '{print $2}' )
[ -n "$TOKEN" ] || die "could not mint a token"

api() {
  local method="$1" path="$2"; shift 2
  local ct=()
  for a in "$@"; do case "$a" in -d|--data|--data-raw) ct=(-H "Content-Type: application/json"); break ;; esac; done
  curl -sS -X "$method" "http://localhost:${PORT}${path}" -H "Authorization: Bearer ${TOKEN}" "${ct[@]}" "$@"
}
api POST "/api/v3/repos/${OWNER}" -d "{\"name\":\"${REPO}\"}" -o /dev/null -f || die "could not create the repo"
ok "organization ${c_c}${OWNER}${c_0}, repository ${c_c}${OWNER}/${REPO}${c_0}, one scoped token"

export GH_ENTERPRISE_TOKEN="$TOKEN"
export SSL_CERT_FILE="$WORKDIR/cert.pem"
gh_() { GH_HOST="$GH_HOST" GH_TOKEN= GITHUB_TOKEN= "$GH_BIN" "$@"; }

# ---------------------------------------------------------------------------
step "The agent's loop — ordinary git and gh, pointed at ADP"

CLONE="$WORKDIR/clone"
git clone "http://x-access-token:${TOKEN}@localhost:${PORT}/${OWNER}/${REPO}.git" "$CLONE" >/dev/null 2>&1 \
  || die "clone failed"
( cd "$CLONE"
  git checkout -B main >/dev/null 2>&1
  git config user.email "agent@example.com"; git config user.name "demo-agent"
  echo "# widget" > README.md
  git add . && git commit -m "initial commit" >/dev/null
  git push origin main >/dev/null 2>&1 ) || die "initial push failed"
info "$ git clone https://${GH_REPO}.git"
ok "cloned and seeded — plain git, no plugin"

api POST "/api/v3/repos/${OWNER}/${REPO}/issues" \
  -d '{"title":"Add a description to the README","body":"It only has a heading."}' -o /dev/null -f \
  || die "could not create the issue"
info "$ gh issue view 1"
gh_ issue view 1 --repo "$GH_REPO" | head -3 | sed 's/^/    /'
ok "the agent reads its task through gh, exactly as on GitHub"

( cd "$CLONE"
  git checkout -b feature >/dev/null 2>&1
  echo "A widget, described." >> README.md
  git commit -am "describe the widget" >/dev/null
  git push origin feature >/dev/null 2>&1 ) || die "feature push failed"
HEAD_SHA=$(git -C "$CLONE" rev-parse feature)
info "$ git push origin feature"
ok "pushed ${HEAD_SHA:0:8}"

CHANGE=$(api GET "/api/adp/repos/${OWNER}/${REPO}/evidence/${HEAD_SHA}")
grep -q '"provenance"' <<<"$CHANGE" || die "the push did not record a change with provenance"
say ""
say "  ${c_y}That push did something a git server would not.${c_0}"
info "ADP recorded a signed change bound to that commit, carrying the identity"
info "that produced it — and the agent did nothing to make that happen. A harness"
info "that supplies its model and session id gets those bound in too."

gh_ pr create --repo "$GH_REPO" --base main --head feature \
  --title "Describe the widget" --body "Closes the README gap." >/dev/null || die "gh pr create failed"
info "$ gh pr create"
ok "proposal opened"

# ---------------------------------------------------------------------------
step "The part that is the point — the merge is refused"

REFUSED=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
  "http://localhost:${PORT}/api/v3/repos/${OWNER}/${REPO}/pulls/1/merge" -H "Authorization: Bearer ${TOKEN}")
[ "$REFUSED" = "422" ] || die "expected the land policy to refuse (422), got $REFUSED"
say "  ${c_y}422 — the land policy refused it.${c_0}"
info "No gate has reported, and nobody has approved. The change is complete and"
info "the agent believes it is done; ADP does not accept belief as evidence."

step "Reporting a gate, and landing it"

api POST "/api/v3/repos/${OWNER}/${REPO}/gates" \
  -d "{\"git_sha\":\"${HEAD_SHA}\",\"name\":\"test\",\"status\":\"success\",\"summary\":\"12 passed\"}" \
  -o /dev/null -f || die "gate report failed"
ok "a gate reported 'test: success — 12 passed'"
info "ADP attests gate results; it never executes them. The runner that does"
info "runs elsewhere, network-denied, with no signing key and no database."

info "$ gh pr checks 1"
gh_ pr checks 1 --repo "$GH_REPO" 2>&1 | sed 's/^/    /' || true
ok "gh sees the gate, its verdict, and a link to the evidence behind it"

api POST "/api/v3/repos/${OWNER}/${REPO}/pulls/1/reviews" \
  -d '{"state":"approved","body":"looks good"}' -o /dev/null -f || die "review failed"
ok "approved"

info "$ gh pr merge 1 --merge"
gh_ pr merge 1 --repo "$GH_REPO" --merge >/dev/null || die "gh pr merge failed"
MAIN_AFTER=$(git --git-dir="${GIT_ROOT}/${OWNER}/${REPO}.git" rev-parse main)
ok "landed — main is now ${MAIN_AFTER:0:8}"

# ---------------------------------------------------------------------------
step "What you can now read back"

BUNDLE=$(api GET "/api/adp/repos/${OWNER}/${REPO}/evidence/${HEAD_SHA}")
echo "$BUNDLE" >"$WORKDIR/evidence.json"
say "  ${c_b}The evidence bundle${c_0} — signed, and bound to the change rather than a branch name:"
node -e '
const b = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const p = (b.change && b.change.provenance) || {};
const g = (b.gates || [])[0] || {};
const row = (k, v) => console.log("    \x1b[2m" + k.padEnd(11) + "\x1b[0m" + v);
const opt = (k, v) => v && row(k, v);
row("commit", b.git_sha.slice(0, 12));
row("actor", [p.kind, p.principal].filter(Boolean).join(" ") || "(unattributed)");
opt("harness", [p.harness, p.model].filter(Boolean).join(" / "));
opt("session", p.session_id);
row("gate", g.name + ": " + g.status + (g.summary ? " — " + g.summary : ""));
row("signature", b.change && b.change.signature
  ? String(b.change.signature).slice(0, 32) + "…" : "(unsigned)");
row("attested", g.envelope ? "DSSE envelope over the gate result" : "(no envelope)");
' "$WORKDIR/evidence.json" || { info "(raw bundle)"; head -c 400 "$WORKDIR/evidence.json" | sed "s/^/    /"; say ""; }

OPS=$(api GET "/api/adp/repos/${OWNER}/${REPO}/operations")
echo "$OPS" >"$WORKDIR/operations.json"
say ""
say "  ${c_b}The operation log${c_0} — every mutation, written in the same transaction as the change:"
node -e '
const ops = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const verbs = ops.map(o => o.verb).reverse();
for (let i = 0; i < verbs.length; i += 4) {
  console.log("    " + verbs.slice(i, i + 4).join("  →  ") + (i + 4 < verbs.length ? "  →" : ""));
}
' "$WORKDIR/operations.json" || info "(see operations.json)"

say ""
say "  ${c_b}Look at any of it yourself, while this instance is still up:${c_0}"
say "    ${c_c}curl -H 'Authorization: Bearer \$TOKEN' \\"
say "      http://localhost:${PORT}/api/adp/repos/${OWNER}/${REPO}/evidence/${HEAD_SHA}${c_0}"
say "    ${c_c}curl -H 'Authorization: Bearer \$TOKEN' \\"
say "      http://localhost:${PORT}/api/adp/repos/${OWNER}/${REPO}/operations${c_0}"
if [ -d server/web/dist ]; then
  say "    ${c_c}open http://localhost:${PORT}/ui/${c_0}   (the read-only supervision UI)"
fi
say ""
say "    export TOKEN=${TOKEN}"
say "    export GH_HOST=${GH_HOST} GH_ENTERPRISE_TOKEN=\$TOKEN SSL_CERT_FILE=${WORKDIR}/cert.pem"

# ---------------------------------------------------------------------------
say ""
say "${c_g}${c_b}Done.${c_0} You landed a policy-compliant change with ordinary git and gh,"
say "watched ADP refuse it while it lacked evidence, and read the signed record"
say "of why it was allowed."
say ""
say "  Run your own instance   ${c_c}docs/self-hosting.md${c_0}"
say "  What the contract promises   ${c_c}docs/api-compatibility.md${c_0}"

if [ "${ADP_DEMO_NO_WAIT:-0}" = "1" ] || [ ! -t 0 ]; then
  info "non-interactive — tearing down now"
else
  say ""
  printf '%sPress Enter to tear everything down.%s ' "$c_dim" "$c_0"
  read -r _ || true
fi
