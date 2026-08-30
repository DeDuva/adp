#!/usr/bin/env bash
# A persistent local instance, with a certificate `gh` will accept.
#
#   make local          bring it up (idempotent) and print how to reach it
#   make local-status   is it up, and on what
#   make local-down     stop it, keeping the data
#   make local-destroy  stop it and delete the data
#
# WHY THIS EXISTS (#158). `gh` refuses plain HTTP for any host but github.com,
# and no override exists — so the GitHub-compatible plane, which is the whole
# point of the compat surface, cannot be exercised against a local instance
# without a real certificate. The manual test plan calls doing that by hand
# "the fiddliest part of the walkthrough".
#
# The machinery to solve it was already here, three times over: acceptance,
# conformance and `make demo` each mint a throwaway certificate and run a proxy
# in front of the server, with port selection below the kernel's ephemeral
# floor and log-line readiness rather than port probes — both of which exist
# because something failed in a way that cost a debugging session. All three
# were test fixtures. A person setting up an instance they could come back to
# got none of it.
#
# THE DEMO/INSTANCE SPLIT. `make demo` is ephemeral by design and correct to
# be: it is a narrated five minutes that installs nothing and leaves nothing.
# The gap was that a visitor who liked it had nowhere to go but the Helm chart.
# This is the same thing with a longer lifetime — the same server from source,
# the same proxy, the same bootstrap — rather than a separate code path with
# different affordances.
#
# NOT A PRODUCTION TLS STORY, and docs/self-hosting.md is right that a real
# deployment needs real ingress. The certificate here is self-signed for
# `localhost`, because no CA will ever issue for `localhost`. It is for
# evaluation and development. Deploying this to anything is not a supported
# configuration and the script says so on its way out.
set -euo pipefail
cd "$(dirname "$0")/../.."

# shellcheck source=scripts/dev/lib.sh
. scripts/dev/lib.sh
# adp_wait_for_log_line: a backgrounded process is ready when it says so, not
# when its port answers — a squatter satisfies a port probe.
# shellcheck source=scripts/dev/ports.sh
. scripts/dev/ports.sh

STATE=".adp-local"
COMPOSE_FILE="deploy/docker-compose.local.yml"
export COMPOSE_PROJECT_NAME="adp-local"

# Fixed, not picked. `PUBLIC_URL` is part of the signed record rather than a
# display string (docs/self-hosting.md §1), so an instance whose URL moved on
# every restart would embed a different one in every landed change. Above the
# usual dev ports and below the kernel's ephemeral floor.
HTTP_PORT="${ADP_LOCAL_HTTP_PORT:-8420}"
TLS_PORT="${ADP_LOCAL_TLS_PORT:-8443}"
PG_PORT="${ADP_LOCAL_PG_PORT:-5434}"
export ADP_LOCAL_PG_PORT="$PG_PORT"

CERT="$STATE/tls/cert.pem"
KEY="$STATE/tls/key.pem"
SERVER_PID_FILE="$STATE/server.pid"
PROXY_PID_FILE="$STATE/proxy.pid"
ENV_FILE="$STATE/env"

alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

# Signal the process group: npx/tsx spawn children that survive a plain kill and
# keep the port bound. Same reasoning as demo.sh's kill_tree, and the same bug
# if it is skipped.
stop_pidfile() {
  local file="$1" pid pgid
  [ -f "$file" ] || return 0
  pid="$(cat "$file")"
  if kill -0 "$pid" 2>/dev/null; then
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
    if [ -n "$pgid" ]; then kill -TERM -- "-$pgid" 2>/dev/null || true; else kill -TERM "$pid" 2>/dev/null || true; fi
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$pid" 2>/dev/null && { [ -n "$pgid" ] && kill -KILL -- "-$pgid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null; } || true
  fi
  rm -f "$file"
}

trust_store_hint() {
  section "trusting the certificate"
  info "The certificate is self-signed, so nothing trusts it until you say so."
  info "It lives at:"
  printf '        %s\n' "$PWD/$CERT"
  echo
  info "Per-tool, no root needed — this is enough for gh, git and curl:"
  printf '        export SSL_CERT_FILE=%s\n' "$PWD/$CERT"
  printf '        export GIT_SSL_CAINFO=%s\n' "$PWD/$CERT"
  echo
  info "Or add it to the machine's trust store, so browsers accept it too:"
  case "$(uname -s)" in
    Darwin)
      printf '        sudo security add-trusted-cert -d -r trustRoot \\\n'
      printf '          -k /Library/Keychains/System.keychain %s\n' "$PWD/$CERT" ;;
    Linux)
      printf '        sudo cp %s /usr/local/share/ca-certificates/adp-local.crt\n' "$PWD/$CERT"
      printf '        sudo update-ca-certificates\n'
      info "On Fedora/RHEL: /etc/pki/ca-trust/source/anchors/ then update-ca-trust" ;;
    *)
      info "Add $PWD/$CERT to this platform's trust store." ;;
  esac
  info "On WSL, a browser running on the Windows side needs it imported there too:"
  printf '        certutil.exe -user -addstore Root %s\n' "$(wslpath -w "$PWD/$CERT" 2>/dev/null || echo "$PWD/$CERT")"
}

print_details() {
  local token
  token="$(grep '^ADP_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"

  section "your instance"
  info "API and git      https://localhost:${TLS_PORT}"
  info "supervision UI   https://localhost:${TLS_PORT}/ui/"
  info "plain HTTP       http://localhost:${HTTP_PORT}   (behind the proxy; gh will not use it)"
  info "database         postgres://adp:adp@localhost:${PG_PORT}/adp"
  info "logs             $STATE/server.log, $STATE/tls-proxy.log"

  trust_store_hint

  section "pointing gh at it"
  info "With SSL_CERT_FILE exported as above:"
  printf '        export GH_HOST=localhost:%s\n' "$TLS_PORT"
  printf '        export GH_ENTERPRISE_TOKEN=%s\n' "$token"
  printf '        gh repo create %s/widget\n' "$(grep '^ADP_ORG=' "$ENV_FILE" | cut -d= -f2-)"
  echo
  info "Everything above is also written to $ENV_FILE — source it with:"
  printf '        set -a; . %s; set +a\n' "$ENV_FILE"

  section "what this is not"
  info "A production deployment. The certificate is self-signed for localhost,"
  info "the server runs from source under your user, and there is no ingress,"
  info "no backup and no second replica. docs/self-hosting.md is the one to"
  info "read when you want a real one."
}

cmd_status() {
  section "adp local instance"
  local up=0
  if docker compose -f "$COMPOSE_FILE" ps --status running --quiet postgres 2>/dev/null | grep -q .; then
    ok "postgres running on :${PG_PORT}"
  else
    info "postgres not running"; up=1
  fi
  if alive "$SERVER_PID_FILE"; then ok "server running on :${HTTP_PORT} (pid $(cat "$SERVER_PID_FILE"))"; else info "server not running"; up=1; fi
  if alive "$PROXY_PID_FILE"; then ok "TLS proxy running on :${TLS_PORT} (pid $(cat "$PROXY_PID_FILE"))"; else info "TLS proxy not running"; up=1; fi
  [ -f "$CERT" ] && ok "certificate at $CERT" || info "no certificate yet"
  return $up
}

cmd_down() {
  section "stopping"
  stop_pidfile "$PROXY_PID_FILE"
  stop_pidfile "$SERVER_PID_FILE"
  ok "server and proxy stopped"
  docker compose -f "$COMPOSE_FILE" stop >/dev/null 2>&1 || true
  ok "postgres stopped — its data is kept"
  info "bring it back with 'make local'; delete the data with 'make local-destroy'"
}

cmd_destroy() {
  cmd_down
  section "destroying"
  # -v takes the named volume with it. This is the only path that deletes the
  # data, and it is a separate verb rather than a flag on `down` for that
  # reason: an instance you have been landing changes against holds the only
  # copy of their signed provenance.
  docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
  rm -rf "$STATE"
  ok "database volume and $STATE removed"
}

cmd_up() {
  section "preflight"
  local docker_status=0
  docker_state || docker_status=$?
  case $docker_status in
    0) ok "docker daemon reachable" ;;
    1) fail "docker binary found, but the daemon is unreachable"; exit 1 ;;
    2) fail "docker not found"; hint "bash scripts/dev/doctor.sh"; exit 1 ;;
  esac
  have openssl || { fail "openssl not found — needed to mint the local certificate"; exit 1; }
  [ -d server/node_modules ] || { fail "server/node_modules missing"; hint "make deps"; exit 1; }

  mkdir -p "$STATE/tls"

  section "database"
  if ! docker compose -f "$COMPOSE_FILE" up -d --wait; then
    fail "postgres did not become healthy"
    docker compose -f "$COMPOSE_FILE" logs --tail 40 postgres || true
    exit 1
  fi
  ok "postgres healthy on :${PG_PORT} (named volume — data survives 'make local-down')"

  section "keys and identity"
  # Minted once and reused. SIGNING_KEY especially: it is what every signature
  # in this instance's history verifies against, so rotating it on each restart
  # would silently invalidate every change already landed here.
  if [ ! -f "$ENV_FILE" ]; then
    umask 077
    cat > "$ENV_FILE" <<EOF
# Written by scripts/dev/local.sh. Holds this instance's signing key and its
# first token — both are secrets, both are stable for the life of the instance.
DATABASE_URL=postgres://adp:adp@localhost:${PG_PORT}/adp
GIT_ROOT=$PWD/$STATE/git
SIGNING_KEY=local-$(openssl rand -hex 16)
MIRROR_CREDENTIAL_KEY=local-$(openssl rand -hex 16)
PUBLIC_URL=https://localhost:${TLS_PORT}
PORT=${HTTP_PORT}
ADP_ORG=local
EOF
    ok "generated a signing key (kept — rotating it would orphan landed signatures)"
  else
    ok "reusing this instance's existing keys"
  fi
  set -a; . "./$ENV_FILE"; set +a
  mkdir -p "$GIT_ROOT"

  section "certificate"
  # 825 days: the longest a leaf certificate may live and still be trusted by
  # Apple's platforms, which is the tightest of the limits that apply. A
  # 1-day certificate is right for a test run and wrong for an instance
  # someone is meant to keep.
  if [ ! -f "$CERT" ]; then
    openssl req -x509 -newkey rsa:2048 -keyout "$KEY" -out "$CERT" \
      -days 825 -nodes -subj "/CN=localhost" \
      -addext "subjectAltName=DNS:localhost,DNS:localhost.localdomain,IP:127.0.0.1" >/dev/null 2>&1
    chmod 600 "$KEY"
    ok "minted a self-signed certificate for localhost, good for 825 days"
  else
    ok "reusing the existing certificate ($CERT)"
  fi

  section "server"
  if alive "$SERVER_PID_FILE"; then
    ok "already running on :${HTTP_PORT}"
  else
    ( cd server && npm run migrate ) >"$STATE/migrate.log" 2>&1 \
      || { tail -20 "$STATE/migrate.log"; fail "migrations failed"; exit 1; }
    # setsid so the instance outlives this shell — that is what "persistent"
    # means here, and it is the one place this differs from demo.sh, whose
    # whole design is that nothing survives it.
    setsid bash -c 'cd server && exec npx tsx src/main.ts' >"$STATE/server.log" 2>&1 &
    echo $! > "$SERVER_PID_FILE"
    for _ in $(seq 1 120); do
      alive "$SERVER_PID_FILE" || { tail -20 "$STATE/server.log"; fail "the server exited before it became healthy"; exit 1; }
      curl -sf "http://localhost:${HTTP_PORT}/healthz" >/dev/null 2>&1 && break
      sleep 0.5
    done
    curl -sf "http://localhost:${HTTP_PORT}/healthz" >/dev/null \
      || { tail -20 "$STATE/server.log"; fail "the server never became healthy"; exit 1; }
    ok "serving on :${HTTP_PORT}"
  fi

  section "TLS"
  if alive "$PROXY_PID_FILE"; then
    ok "already terminating TLS on :${TLS_PORT}"
  else
    : > "$STATE/tls-proxy.log"
    setsid bash -c "cd server && exec node tls-proxy.mjs '$PWD/$CERT' '$PWD/$KEY' '$TLS_PORT' '$HTTP_PORT'" \
      >"$STATE/tls-proxy.log" 2>&1 &
    echo $! > "$PROXY_PID_FILE"
    # The proxy's own startup line, not a port probe: the line proves this
    # process is serving, where an open port only proves something is.
    adp_wait_for_log_line "$STATE/tls-proxy.log" '^tls-proxy: ' "$(cat "$PROXY_PID_FILE")" \
      || { cat "$STATE/tls-proxy.log"; fail "the TLS proxy never came up on :${TLS_PORT}"; exit 1; }
    ok "terminating TLS on :${TLS_PORT} — gh will talk to this"
  fi

  section "first token"
  if grep -q '^ADP_TOKEN=' "$ENV_FILE"; then
    ok "reusing this instance's first token"
  else
    local token
    token=$( cd server && npx tsx src/bootstrap.ts "$(git config user.email 2>/dev/null || echo you@localhost)" --org "$ADP_ORG" 2>&1 | grep '^Token:' | awk '{print $2}' )
    [ -n "$token" ] || { fail "could not mint a token"; exit 1; }
    printf 'ADP_TOKEN=%s\nGH_HOST=localhost:%s\nGH_ENTERPRISE_TOKEN=%s\nSSL_CERT_FILE=%s\nGIT_SSL_CAINFO=%s\n' \
      "$token" "$TLS_PORT" "$token" "$PWD/$CERT" "$PWD/$CERT" >> "$ENV_FILE"
    ok "minted an admin token for org '$ADP_ORG' (stored in $ENV_FILE, mode 600)"
  fi

  print_details
}

case "${1:-up}" in
  up) cmd_up ;;
  down) cmd_down ;;
  destroy) cmd_destroy ;;
  status) cmd_status ;;
  *) echo "usage: local.sh [up|down|destroy|status]" >&2; exit 2 ;;
esac
