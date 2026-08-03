#!/usr/bin/env bash
# The definition of done (docs/pragmatic_mvp.md §2.1), executable.
#
# docs/manual-test-plan.md is this same walkthrough written for a person; the
# step numbers below match it, so a failure here points at a section there.
#
# Related but not the same as conformance/run.sh. That gate asks one question —
# "does a real, unmodified `gh` work against this server?" — and is deliberately
# narrow so it stays a stable compatibility signal. This asks the whole §2.1
# question, including the parts `gh` cannot see: the evidence bundle, the
# operation log, and undo. The setup overlaps; the assertions do not.
#
#   bash server/acceptance/run.sh          # steps B1-B8, C10-C12
#   ADP_ACCEPTANCE_UI=1 ... run.sh         # also drive the web UI (Playwright)
#
# Needs DATABASE_URL. `make acceptance` supplies it from .env.test.
set -euo pipefail
cd "$(dirname "$0")/.."

GH_VERSION="${GH_VERSION:-2.63.0}"
PORT="${ADP_ACCEPTANCE_PORT:-$((20000 + RANDOM % 20000))}"
TLS_PORT="${ADP_ACCEPTANCE_TLS_PORT:-$((40000 + RANDOM % 20000))}"
WORKDIR="$(mktemp -d -t adp-acceptance-XXXXXX)"
GH_HOST="localhost:${TLS_PORT}"
ARTIFACTS="${ADP_ACCEPTANCE_ARTIFACTS:-$(cd .. && pwd)/.adp-test/acceptance}"

SELF_PGID="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"

# Signal the process group, not the pid: `npx`/`tsx` spawn children that
# survive a plain `kill` and keep the port bound. Same fix as conformance's —
# see the comment there, and docs/test-environment-automation.md finding 11.
kill_tree() {
  local pid="${1:-}" pgid
  [ -n "$pid" ] || return 0
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  if [ -n "$pgid" ] && [ "$pgid" != "$SELF_PGID" ]; then
    kill -TERM -- "-$pgid" 2>/dev/null || true
    return 0
  fi
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

pass() { printf '  \033[32mok\033[0m    %s\n' "$*"; }
note() { printf '  \033[2m--\033[0m    %s\n' "$*"; }
step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
fail() { printf '\033[31mACCEPTANCE FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

# Content-Type is only sent when there is a body. Setting it unconditionally
# makes Fastify's JSON parser reject a bodyless POST with 400
# (FST_ERR_CTP_EMPTY_JSON_BODY) — which is what the undo endpoint is, since it
# takes everything it needs from the URL. server/web/src/api.ts gets this right
# for the same reason; this helper did not.
api() {
  local method="$1" path="$2"
  shift 2
  local ct=()
  for arg in "$@"; do
    case "$arg" in -d|--data|--data-raw|--data-binary) ct=(-H "Content-Type: application/json"); break ;; esac
  done
  curl -sS -X "$method" "http://localhost:${PORT}${path}" \
    -H "Authorization: Bearer ${TOKEN}" "${ct[@]}" "$@"
}

step "A — environment"
[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is not set (run 'make up' first, or use 'make acceptance')"
export GIT_ROOT="$WORKDIR/git"
export SIGNING_KEY="acceptance-$(openssl rand -hex 8)"
export MIRROR_CREDENTIAL_KEY="acceptance-$(openssl rand -hex 8)"
export PUBLIC_URL="http://localhost:${PORT}"
export PORT
mkdir -p "$GIT_ROOT" "$ARTIFACTS"
note "workdir $WORKDIR"
note "artifacts $ARTIFACTS"

# The UI is only served when it has been built; main.ts skips /ui/* with a log
# line otherwise, so an unbuilt UI would make step C silently vacuous.
if [ "${ADP_ACCEPTANCE_UI:-0}" = "1" ] && [ ! -d web/dist ]; then
  fail "ADP_ACCEPTANCE_UI=1 but server/web/dist is missing — run 'npm run build --prefix server/web'"
fi

GH_CACHE="${GH_CACHE_DIR:-$HOME/.cache/adp-conformance-gh}/${GH_VERSION}"
GH_BIN="$GH_CACHE/gh_${GH_VERSION}_linux_amd64/bin/gh"
if [ ! -x "$GH_BIN" ]; then
  note "fetching gh $GH_VERSION"
  mkdir -p "$GH_CACHE"
  curl -sL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
    -o "$WORKDIR/gh.tar.gz"
  tar -xzf "$WORKDIR/gh.tar.gz" -C "$GH_CACHE"
fi
pass "gh $("$GH_BIN" --version | head -1 | awk '{print $3}')"

npm run migrate >/dev/null 2>&1
npx tsx src/main.ts > "$WORKDIR/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do
  kill -0 "$SERVER_PID" 2>/dev/null || { cat "$WORKDIR/server.log"; fail "server exited before becoming healthy"; }
  curl -sf "http://localhost:${PORT}/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "http://localhost:${PORT}/healthz" >/dev/null || { cat "$WORKDIR/server.log"; fail "server never became healthy"; }
pass "server healthy on :$PORT"

# `gh` refuses plain HTTP for any non-github.com host (B1 in the manual plan).
openssl req -x509 -newkey rsa:2048 -keyout "$WORKDIR/key.pem" -out "$WORKDIR/cert.pem" \
  -days 1 -nodes -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost" >/dev/null 2>&1
node conformance/tls-proxy.mjs "$WORKDIR/cert.pem" "$WORKDIR/key.pem" "$TLS_PORT" "$PORT" \
  > "$WORKDIR/tls-proxy.log" 2>&1 &
PROXY_PID=$!
pass "TLS proxy on :$TLS_PORT"

OWNER="acceptance-$$"
REPO="widget"
TOKEN=$(npx tsx src/bootstrap.ts "acceptance-actor-$$" 2>&1 | grep '^Token:' | awk '{print $2}')
[ -n "$TOKEN" ] || fail "bootstrap didn't mint a token"
api POST "/api/v3/repos/${OWNER}" -d "{\"name\":\"${REPO}\"}" -o /dev/null -f || fail "repo create failed"
pass "repo ${OWNER}/${REPO}"

export GH_ENTERPRISE_TOKEN="$TOKEN"
export SSL_CERT_FILE="$WORKDIR/cert.pem"
GH_REPO="${GH_HOST}/${OWNER}/${REPO}"

# The first thing a human runs after pointing gh at a new host, and — until
# 2026-08-03 — the one gh command nothing here or in conformance/ ever
# exercised. It probes `GET /api/v3/` *with* a trailing slash, which Fastify
# treated as a distinct route from the registered `/api/v3` and 404'd, so gh
# declared a perfectly valid token invalid. Fixed by ignoreTrailingSlash in
# src/main.ts; this asserts it, because that option lives in main.ts and no
# unit test that builds its own Fastify instance can guard it.
GH_HOST="$GH_HOST" gh auth status 2>&1 | grep -q "Logged in to ${GH_HOST}" \
  || fail "A5: gh auth status did not report a working login"
pass "A5 gh auth status"

step "B — the agent's loop"

# B2 — clone
CLONE="$WORKDIR/clone"
git clone "http://x-access-token:${TOKEN}@localhost:${PORT}/${OWNER}/${REPO}.git" "$CLONE" >/dev/null 2>&1 \
  || fail "B2: clone failed"
(
  cd "$CLONE"
  git checkout -B main >/dev/null 2>&1
  git config user.email "acceptance@example.com"
  git config user.name "Acceptance"
  echo "# widget" > README.md
  git add . && git commit -m "initial commit" >/dev/null
  git push origin main >/dev/null 2>&1
) || fail "B2: initial push failed"
pass "B2 clone and push"

# B3 — read the task. The issue *is* a typed intent server-side.
api POST "/api/v3/repos/${OWNER}/${REPO}/issues" \
  -d '{"title":"Add a description to the README","body":"It only has a heading."}' -o /dev/null -f \
  || fail "B3: issue create failed"
ISSUE_OUT=$("$GH_BIN" issue view 1 --repo "$GH_REPO") || fail "B3: gh issue view failed"
grep -q "Add a description to the README" <<<"$ISSUE_OUT" || fail "B3: issue title missing from gh output"
pass "B3 gh issue view shows the intent"

# B4 — edit and push. post-receive auto-records a signed change.
(
  cd "$CLONE"
  git checkout -b feature >/dev/null 2>&1
  echo "A widget, described." >> README.md
  git commit -am "describe the widget" >/dev/null
  git push origin feature >/dev/null 2>&1
) || fail "B4: feature push failed"
HEAD_SHA=$(git -C "$CLONE" rev-parse feature)
pass "B4 pushed $(cut -c1-8 <<<"$HEAD_SHA")"

# The push must have auto-recorded a change with provenance — the agent saw
# nothing about this, which is the point of the projection.
CHANGE=$(api GET "/api/adp/repos/${OWNER}/${REPO}/evidence/${HEAD_SHA}")
grep -q '"provenance"' <<<"$CHANGE" || fail "B4: push did not auto-record a change with provenance"
pass "B4 post-receive auto-recorded a signed change"

# B5 — propose
"$GH_BIN" pr create --repo "$GH_REPO" --base main --head feature \
  --title "Describe the widget" --body "Closes the README gap." >/dev/null \
  || fail "B5: gh pr create failed"
pass "B5 gh pr create"

# B8 (early) — a land policy that has never refused anything is untested.
REFUSED=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
  "http://localhost:${PORT}/api/v3/repos/${OWNER}/${REPO}/pulls/1/merge" \
  -H "Authorization: Bearer ${TOKEN}")
[ "$REFUSED" = "422" ] || fail "B8: expected the land policy to refuse an ungated, unapproved merge (422), got $REFUSED"
pass "B8 land policy refuses before gates and approval"

# B6 — report a gate result, then check the rollup.
api POST "/api/v3/repos/${OWNER}/${REPO}/gates" \
  -d "{\"git_sha\":\"${HEAD_SHA}\",\"name\":\"test\",\"status\":\"success\",\"summary\":\"12 passed\"}" \
  -o /dev/null -f || fail "B6: gate report failed"

# Reached through PullRequest.commits, not Repository.object — `object` has no
# resolver, so that path returns null however green the rollup is. This is the
# same traversal `gh pr checks` performs, which is why the empty `contexts`
# connection below is what breaks it rather than a missing state.
ROLLUP=$(api POST "/api/graphql" -d "$(cat <<JSON
{"query":"query { repository(owner:\\"${OWNER}\\", name:\\"${REPO}\\") { pullRequest(number:1) { commits(first:100) { nodes { commit { oid statusCheckRollup { state } } } } } } }"}
JSON
)")
grep -q '"state":"SUCCESS"' <<<"$ROLLUP" \
  || fail "B6: expected a commit with statusCheckRollup.state SUCCESS, got: $ROLLUP"
pass "B6 statusCheckRollup is SUCCESS"

# ...and record what `gh pr checks` actually does with it. This is the one part
# of §2.1 not met: the rollup *state* is real, but `gh pr checks` enumerates
# `contexts`, which resolvers.ts returns as a deliberately empty connection —
# so gh reports "no checks reported" and exits non-zero even on a green rollup.
# Asserted as a known gap rather than skipped, so that implementing contexts
# makes this test fail loudly and demand updating, instead of passing silently.
GH_CHECKS_OUT=$("$GH_BIN" pr checks 1 --repo "$GH_REPO" 2>&1) && GH_CHECKS_RC=0 || GH_CHECKS_RC=$?
if [ "$GH_CHECKS_RC" = "0" ]; then
  fail "B6: 'gh pr checks' now succeeds — per-context detail appears to be implemented.
       That closes a documented §2.1 gap. Update this assertion, docs/manual-test-plan.md
       step B6, and the gh table in README.md. Output was:
$GH_CHECKS_OUT"
fi
grep -qi "no checks reported" <<<"$GH_CHECKS_OUT" \
  || fail "B6: 'gh pr checks' failed for an unexpected reason: $GH_CHECKS_OUT"
note "B6 known gap: 'gh pr checks' reports \"no checks reported\" — contexts is an empty connection"

# B7 — typed review
api POST "/api/v3/repos/${OWNER}/${REPO}/pulls/1/reviews" \
  -d '{"state":"approved","body":"looks good"}' -o /dev/null -f || fail "B7: review failed"
PR_OUT=$("$GH_BIN" pr view 1 --repo "$GH_REPO") || fail "B7: gh pr view failed"
grep -q "Describe the widget" <<<"$PR_OUT" || fail "B7: PR title missing from gh output"
pass "B7 typed review recorded, gh pr view shows the PR"

# B8 — land. merge_method defaults to "merge" (GitHub's own default, and
# `--merge` asks for it explicitly) — main lands on a real merge commit, not
# a reused copy of the feature head, so main != HEAD_SHA is the fidelity win
# here (docs/m2-readiness-review.md's merge-method-fidelity item), and the
# feature head must still be reachable from main afterward.
MAIN_BEFORE=$(git --git-dir="${GIT_ROOT}/${OWNER}/${REPO}.git" rev-parse main)
"$GH_BIN" pr merge 1 --repo "$GH_REPO" --merge >/dev/null || fail "B8: gh pr merge failed"
MAIN_AFTER=$(git --git-dir="${GIT_ROOT}/${OWNER}/${REPO}.git" rev-parse main)
[ "$MAIN_AFTER" != "$HEAD_SHA" ] || fail "B8: main should have landed on a new merge commit, not the reused feature head"
git --git-dir="${GIT_ROOT}/${OWNER}/${REPO}.git" merge-base --is-ancestor "$HEAD_SHA" "$MAIN_AFTER" \
  || fail "B8: feature head is not reachable from main after the merge"
pass "B8 gh pr merge landed it as a merge commit (main $(cut -c1-8 <<<"$MAIN_BEFORE") -> $(cut -c1-8 <<<"$MAIN_AFTER"))"

step "C — the human's supervision"

# C10 — the evidence bundle: intent, provenance, signature, gate result.
BUNDLE=$(api GET "/api/adp/repos/${OWNER}/${REPO}/evidence/${HEAD_SHA}")
echo "$BUNDLE" > "$ARTIFACTS/evidence-bundle.json"
for field in provenance signature; do
  grep -q "\"${field}\"" <<<"$BUNDLE" || fail "C10: evidence bundle has no '${field}'"
done
grep -q '"12 passed"' <<<"$BUNDLE" || fail "C10: evidence bundle does not carry the gate result"
pass "C10 evidence bundle carries provenance, signature and the gate result"

# C11 — the operation log. Every mutation writes a row in the same transaction.
OPS=$(api GET "/api/adp/repos/${OWNER}/${REPO}/operations")
echo "$OPS" > "$ARTIFACTS/operations.json"
for verb in repo.create issue.create change.create proposal.create gate.report review.create proposal.merge; do
  grep -q "\"${verb}\"" <<<"$OPS" || fail "C11: operation log is missing a '${verb}' entry"
done
pass "C11 operation log records the whole cycle"

# C12 — undo. §2.1 says the human "clicks undo", so when the UI is in play the
# click is what performs it and this script only asserts the consequence. With
# the UI off, the REST call stands in for the click. Either way the assertion is
# the same and is made here: the server-side ref moved back. An API response
# saying "ok" is not evidence that a merge was reverted.
MERGE_OP=$(node -e '
  const ops = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const op = ops.find((o) => o.verb === "proposal.merge");
  if (!op) { process.exit(1); }
  process.stdout.write(op.id);
' "$ARTIFACTS/operations.json") || fail "C12: no proposal.merge operation to undo"

if [ "${ADP_ACCEPTANCE_UI:-0}" = "1" ]; then
  step "C9-C12 — web UI (Playwright)"
  ADP_UI_BASE="http://localhost:${PORT}" \
  ADP_UI_TOKEN="$TOKEN" \
  ADP_UI_OWNER="$OWNER" \
  ADP_UI_REPO="$REPO" \
  ADP_UI_ARTIFACTS="$ARTIFACTS" \
  ADP_UI_UNDO=1 \
    npx playwright test --config acceptance/playwright.config.ts \
    || fail "the web UI checks failed"
  pass "C9-C11 UI rendered the intent, evidence, provenance and op log"
  pass "C12 undo performed by clicking Undo in the UI"
  note "screenshots in $ARTIFACTS"
else
  note "web UI checks skipped (set ADP_ACCEPTANCE_UI=1 to run them)"
  api POST "/api/adp/repos/${OWNER}/${REPO}/operations/${MERGE_OP}/undo" -o /dev/null -f \
    || fail "C12: undo call failed"
  pass "C12 undo performed over REST (no UI)"
fi

MAIN_UNDONE=$(git --git-dir="${GIT_ROOT}/${OWNER}/${REPO}.git" rev-parse main)
[ "$MAIN_UNDONE" = "$MAIN_BEFORE" ] \
  || fail "C12: undo did not move main back (want $MAIN_BEFORE, got $MAIN_UNDONE)"
OPS_AFTER=$(api GET "/api/adp/repos/${OWNER}/${REPO}/operations")
grep -q '"proposal.merge.undo"' <<<"$OPS_AFTER" || fail "C12: the undo did not record its own operation"
pass "C12 main is back at $(cut -c1-8 <<<"$MAIN_BEFORE") and the undo recorded itself"

step "D — the M2 trust-plane ramp"
REPO_ROOT="$(cd .. && pwd)"

# D13 — telemetry. Real traffic has been flowing since Part B; read it back.
METRICS=$(curl -sS "http://localhost:${PORT}/metrics")
grep -q '^# TYPE adp_http_requests_total counter$' <<<"$METRICS" || fail "D13: /metrics missing the HTTP counter family"
grep -q '^adp_http_requests_total{' <<<"$METRICS" || fail "D13: /metrics has no HTTP request samples"
grep -q '^adp_graphql_operations_total{' <<<"$METRICS" || fail "D13: /metrics has no GraphQL operation samples"
pass "D13 /metrics carries real REST and GraphQL counters"

# D14 — the adp CLI: a second client against the same REST surface gh and
# curl have been using. Built once, cached like the pinned gh binary above.
CLI_BIN="$REPO_ROOT/cli/dist/index.js"
if [ ! -f "$CLI_BIN" ]; then
  note "building adp CLI"
  npm ci --prefix "$REPO_ROOT/cli" >/dev/null 2>&1 || fail "D14: npm ci --prefix cli failed"
  npm run build --prefix "$REPO_ROOT/cli" >/dev/null 2>&1 || fail "D14: adp CLI build failed"
fi
CLI_OUT=$(ADP_SERVER_URL="http://localhost:${PORT}" ADP_TOKEN="$TOKEN" node "$CLI_BIN" pr list --repo "${OWNER}/${REPO}") \
  || fail "D14: adp pr list failed"
# C12 undid the merge and reopened the PR, so state here is "open" again —
# check the title, the same state-independent signal B7's `gh pr view` used.
grep -q "Describe the widget" <<<"$CLI_OUT" || fail "D14: adp pr list did not show the PR"
pass "D14 adp CLI (pr list) shows the same PR gh and curl already saw"

# D15 — outbound webhooks: register a hook, then trigger a real signed
# delivery against a real local listener (not a mock of core/webhooks.ts).
WEBHOOK_SECRET="acceptance-webhook-$(openssl rand -hex 8)"
WEBHOOK_PORT=$((30000 + RANDOM % 10000))
WEBHOOK_RECEIVED="$WORKDIR/webhook-received.json"
node -e '
const http = require("node:http");
const fs = require("node:fs");
const [port, outFile] = process.argv.slice(1);
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    fs.writeFileSync(outFile, JSON.stringify({ headers: req.headers, body }));
    res.writeHead(200); res.end("ok");
  });
}).listen(Number(port));
' "$WEBHOOK_PORT" "$WEBHOOK_RECEIVED" &
WEBHOOK_LISTENER_PID=$!
sleep 0.3

api POST "/api/v3/repos/${OWNER}/${REPO}/hooks" \
  -d "{\"config\":{\"url\":\"http://127.0.0.1:${WEBHOOK_PORT}/\",\"secret\":\"${WEBHOOK_SECRET}\"},\"events\":[\"push\"]}" \
  -o /dev/null -f || fail "D15: hook registration failed"

(
  cd "$CLONE"
  git checkout -b webhook-trigger >/dev/null 2>&1
  echo "trigger" >> README.md
  git commit -am "trigger the outbound webhook" >/dev/null
  git push origin webhook-trigger >/dev/null 2>&1
) || fail "D15: trigger push failed"

for _ in $(seq 1 20); do [ -s "$WEBHOOK_RECEIVED" ] && break; sleep 0.5; done
kill_tree "$WEBHOOK_LISTENER_PID"
[ -s "$WEBHOOK_RECEIVED" ] || fail "D15: webhook listener never received a delivery"

WEBHOOK_BODY=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).body))' "$WEBHOOK_RECEIVED")
WEBHOOK_SIG=$(printf '%s' "$WEBHOOK_BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')
WEBHOOK_GOT_SIG=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).headers["x-hub-signature-256"]))' "$WEBHOOK_RECEIVED")
[ "$WEBHOOK_GOT_SIG" = "sha256=${WEBHOOK_SIG}" ] || fail "D15: webhook signature did not verify against the configured secret"
grep -q '"ref":"refs/heads/webhook-trigger"' <<<"$WEBHOOK_BODY" || fail "D15: webhook payload missing the pushed ref"
pass "D15 outbound webhook delivered a correctly HMAC-signed push event"

# D16 — a scanner-as-gate adapter. osv-scanner's has zero runtime
# dependencies, so it runs directly against a fixture captured from a real
# scan (adapters/test/) — no install, no mocked scanner output.
CLI_OUT=$(node "$REPO_ROOT/adapters/osv-scanner/run.mjs" \
  --json "$REPO_ROOT/adapters/test/fixtures/osv-scanner-real.json" \
  --repo "${OWNER}/${REPO}" --sha "$HEAD_SHA" \
  --server "http://localhost:${PORT}" --token "$TOKEN") || fail "D16: osv-scanner adapter failed"
grep -q '^osv-scanner gate reported: failure' <<<"$CLI_OUT" || fail "D16: adapter did not report the expected failure verdict"
EVIDENCE_AFTER_SCAN=$(api GET "/api/adp/repos/${OWNER}/${REPO}/evidence/${HEAD_SHA}")
grep -q '"name":"osv-scanner"' <<<"$EVIDENCE_AFTER_SCAN" || fail "D16: evidence bundle missing the osv-scanner gate"
pass "D16 osv-scanner adapter reported a real scan result, now in evidence"

# D17 — dependency admission: typed per-package verdicts, live against the
# real OSV.dev API (docs/pragmatic_mvp.md). sdxcode1@9.9.9 is a real
# OpenSSF-reported malicious npm package (MAL-2025-2155); is-odd@3.0.1 is
# real, old, and clean.
DEP_RES=$(api POST "/api/v3/repos/${OWNER}/${REPO}/dependency-admission" \
  -d "{\"git_sha\":\"${HEAD_SHA}\",\"packages\":[{\"ecosystem\":\"npm\",\"name\":\"is-odd\",\"version\":\"3.0.1\"},{\"ecosystem\":\"npm\",\"name\":\"sdxcode1\",\"version\":\"9.9.9\"}]}")
grep -q '"status":"failure"' <<<"$DEP_RES" || fail "D17: expected an overall 'failure' status (a blocked package outranks a clean one)"
grep -q 'MAL-' <<<"$DEP_RES" || fail "D17: expected the malicious package's reasons to cite an OpenSSF MAL- advisory"
pass "D17 dependency admission blocked a real OpenSSF-reported malicious package"

# D18 — SBOM per land: generated automatically on every merge (no separate
# "generate SBOM" step), same real-fixture pattern as D16/D17 rather than a
# synthetic manifest — a real `npm install` output.
SBOM_REPO="sbom-demo"
api POST "/api/v3/repos/${OWNER}" -d "{\"name\":\"${SBOM_REPO}\"}" -o /dev/null -f || fail "D18: repo create failed"
SBOM_CLONE="$WORKDIR/sbom-clone"
git clone "http://x-access-token:${TOKEN}@localhost:${PORT}/${OWNER}/${SBOM_REPO}.git" "$SBOM_CLONE" >/dev/null 2>&1 \
  || fail "D18: clone failed"
(
  cd "$SBOM_CLONE"
  git checkout -B main >/dev/null 2>&1
  git config user.email "acceptance@example.com"
  git config user.name "Acceptance"
  echo "# sbom-demo" > README.md
  git add . && git commit -m "initial commit" >/dev/null
  git push origin main >/dev/null 2>&1
  git checkout -b feature >/dev/null 2>&1
  # A hand-built lockfile, not server/test/fixtures/sbom-package-lock.json:
  # core/sbom.ts's componentsFromNpmLockfile only reads packages[path].version,
  # so a real lockfile's base64 `integrity` hashes add nothing here — and
  # those hashes are exactly high-entropy enough to trip the real pre-receive
  # secret scanner this push actually goes through (unlike
  # test/e2e-sbom.test.ts, which never wires up hooks.ts at all). Same two
  # real packages either way.
  cat > package-lock.json <<'JSON'
{
  "name": "sbom-demo",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "sbom-demo", "version": "1.0.0" },
    "node_modules/is-odd": { "version": "3.0.1" },
    "node_modules/lodash": { "version": "4.17.15" }
  }
}
JSON
  git add . && git commit -m "add lockfile" >/dev/null
  git push origin feature >/dev/null 2>&1
) || fail "D18: lockfile push failed"
SBOM_HEAD_SHA=$(git -C "$SBOM_CLONE" rev-parse feature)

SBOM_PR=$(api POST "/api/v3/repos/${OWNER}/${SBOM_REPO}/pulls" \
  -d '{"title":"Add a lockfile","head":"feature","base":"main"}')
# process.stdout.write(String(...)), not console.log: console.log runs
# non-string values through util.inspect, which colorizes numbers (ANSI
# codes) whenever the environment sets FORCE_COLOR — silently corrupting a
# value this script feeds straight back into a URL path.
SBOM_PR_NUM=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).number))' <<<"$SBOM_PR")
api POST "/api/v3/repos/${OWNER}/${SBOM_REPO}/gates" \
  -d "{\"git_sha\":\"${SBOM_HEAD_SHA}\",\"name\":\"test\",\"status\":\"success\",\"summary\":\"ok\"}" -o /dev/null -f \
  || fail "D18: gate report failed"
api POST "/api/v3/repos/${OWNER}/${SBOM_REPO}/pulls/${SBOM_PR_NUM}/reviews" \
  -d '{"state":"approved","body":"lgtm"}' -o /dev/null -f || fail "D18: review failed"
api PUT "/api/v3/repos/${OWNER}/${SBOM_REPO}/pulls/${SBOM_PR_NUM}/merge" -d '{}' -o /dev/null -f \
  || fail "D18: merge failed"

SBOM_EVIDENCE=$(api GET "/api/adp/repos/${OWNER}/${SBOM_REPO}/evidence/${SBOM_HEAD_SHA}")
grep -q '"name":"sbom"' <<<"$SBOM_EVIDENCE" || fail "D18: evidence bundle missing the sbom gate"
node -e '
  const b = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const g = b.gates.find((x) => x.name === "sbom");
  const payload = JSON.parse(Buffer.from(g.envelope.payload, "base64").toString("utf8"));
  if (payload.predicateType !== "https://cyclonedx.org/bom") {
    console.error(`D18: predicateType is ${payload.predicateType}, not CycloneDX`);
    process.exit(1);
  }
  const names = payload.predicate.components.map((c) => c.name);
  for (const want of ["is-odd", "lodash"]) {
    if (!names.includes(want)) {
      console.error(`D18: sbom components missing ${want} (got ${JSON.stringify(names)})`);
      process.exit(1);
    }
  }
' <<<"$SBOM_EVIDENCE" || fail "D18: sbom evidence did not decode to the expected CycloneDX components"
pass "D18 SBOM per land: a real npm lockfile became a CycloneDX evidence entry"

# D19 — mirror mode: outbound (ADP -> "GitHub") and inbound ("GitHub" ->
# ADP) against a plain local bare repo standing in for GitHub, same pattern
# as test/e2e-mirror.test.ts — no live GitHub credential needed to prove
# the mechanism.
MIRROR_REPO="mirror-demo"
api POST "/api/v3/repos/${OWNER}" -d "{\"name\":\"${MIRROR_REPO}\"}" -o /dev/null -f || fail "D19: repo create failed"
MIRROR_STANDIN="$WORKDIR/github-standin.git"
git init --bare -q --initial-branch main "$MIRROR_STANDIN"

MIRROR_SECRET="acceptance-mirror-$(openssl rand -hex 8)"
MIRROR_OUT=$(ADP_SERVER_URL="http://localhost:${PORT}" ADP_TOKEN="$TOKEN" node "$CLI_BIN" repo mirror "${OWNER}/${MIRROR_REPO}" \
  --remote-url "file://${MIRROR_STANDIN}" --secret "$MIRROR_SECRET" --credential "unused-for-file-remote" --direction both) \
  || fail "D19: adp repo mirror failed"

MIRROR_CLONE="$WORKDIR/mirror-clone"
git clone "http://x-access-token:${TOKEN}@localhost:${PORT}/${OWNER}/${MIRROR_REPO}.git" "$MIRROR_CLONE" >/dev/null 2>&1 \
  || fail "D19: mirror repo clone failed"
(
  cd "$MIRROR_CLONE"
  git checkout -B main >/dev/null 2>&1
  git config user.email "acceptance@example.com"
  git config user.name "Acceptance"
  echo "outbound" > f.txt
  git add . && git commit -m "outbound commit" >/dev/null
  git push origin main >/dev/null 2>&1
) || fail "D19: outbound push failed"
MIRROR_OUT_SHA=$(git -C "$MIRROR_CLONE" rev-parse main)

# Give the background poller (MIRROR_POLL_INTERVAL_MS, 5s by default) a few
# ticks to pick up the outbox row hooks.ts queued.
MIRROR_SYNCED=0
for _ in $(seq 1 15); do
  [ "$(git --git-dir="$MIRROR_STANDIN" rev-parse main 2>/dev/null)" = "$MIRROR_OUT_SHA" ] && { MIRROR_SYNCED=1; break; }
  sleep 1
done
[ "$MIRROR_SYNCED" = "1" ] || fail "D19: outbound mirror sync never landed on the stand-in repo"
pass "D19 mirror outbound: a real ADP push landed on the GitHub stand-in via the poller"

MIRROR_INBOUND_CLONE="$WORKDIR/mirror-inbound-clone"
git clone -q "$MIRROR_STANDIN" "$MIRROR_INBOUND_CLONE"
(
  cd "$MIRROR_INBOUND_CLONE"
  git config user.email "acceptance@example.com"
  git config user.name "Acceptance"
  echo "inbound" > g.txt
  git add . && git commit -m "inbound commit" >/dev/null
  git push origin main >/dev/null 2>&1
) || fail "D19: inbound (direct-to-standin) push failed"
MIRROR_IN_SHA=$(git -C "$MIRROR_INBOUND_CLONE" rev-parse main)

MIRROR_PAYLOAD="{\"ref\":\"refs/heads/main\",\"after\":\"${MIRROR_IN_SHA}\"}"
MIRROR_SIG=$(printf '%s' "$MIRROR_PAYLOAD" | openssl dgst -sha256 -hmac "$MIRROR_SECRET" | awk '{print $2}')
MIRROR_WEBHOOK_RES=$(curl -sS -X POST "http://localhost:${PORT}/webhooks/github/${OWNER}/${MIRROR_REPO}" \
  -H "Content-Type: application/json" -H "X-Hub-Signature-256: sha256=${MIRROR_SIG}" -d "$MIRROR_PAYLOAD")
grep -q '"ok":true' <<<"$MIRROR_WEBHOOK_RES" || fail "D19: inbound webhook replay failed: $MIRROR_WEBHOOK_RES"

ADP_MAIN_AFTER_INBOUND=$(git --git-dir="${GIT_ROOT}/${OWNER}/${MIRROR_REPO}.git" rev-parse main)
[ "$ADP_MAIN_AFTER_INBOUND" = "$MIRROR_IN_SHA" ] || fail "D19: ADP's main did not fast-forward to the inbound sha"
MIRROR_EVIDENCE=$(api GET "/api/adp/repos/${OWNER}/${MIRROR_REPO}/evidence/${MIRROR_IN_SHA}")
grep -q '"via":"mirror-inbound"' <<<"$MIRROR_EVIDENCE" || fail "D19: inbound change's provenance does not name mirror-inbound"
pass "D19 mirror inbound: a signed GitHub-shaped webhook auto-recorded a change ADP never saw pushed to it"

printf '\n\033[32m== acceptance: the §2.1 walkthrough passed end to end ==\033[0m\n'
