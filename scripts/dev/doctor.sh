#!/usr/bin/env bash
# Preflight: can this machine actually run the ADP test suite?
#
# Run this BEFORE anything else. Every check here corresponds to a way a run
# has silently produced a wrong answer rather than an obvious error — a missing
# git-http-backend, a Docker daemon that isn't there, a stale container holding
# port 3000, a Node major that doesn't match CI. See
# docs/test-environment-automation.md.
#
# Exit 0 = good to go (warnings are advisory). Exit 1 = something will break.
set -uo pipefail

# shellcheck source=scripts/dev/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

section "platform"
if grep -qiE "microsoft|wsl" /proc/version 2>/dev/null; then
  info "WSL detected ($(uname -r))"
else
  info "$(uname -srm)"
fi
info "repo root: $ADP_REPO_ROOT"

section "toolchain"

if have git; then
  ok "git $(git --version | awk '{print $3}')"
  # git smart-HTTP is delegated to the real git-http-backend CGI. It ships with
  # git but lives in the exec-path, not on PATH — and some minimal/stripped
  # packagings omit it, which surfaces much later as a confusing clone failure.
  git_exec="$(git --exec-path 2>/dev/null)"
  if [ -n "$git_exec" ] && [ -x "$git_exec/git-http-backend" ]; then
    ok "git-http-backend present"
  else
    fail "git-http-backend not found in git exec-path ($git_exec)"
    hint "the git smart-HTTP routes delegate to it; clone/push tests cannot pass without it"
    hint "on Debian/Ubuntu it is part of the 'git' package — try reinstalling git"
  fi
else
  fail "git not found"
fi

if have node; then
  node_major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "$node_major" = "$ADP_NODE_MAJOR" ]; then
    ok "node $(node -v)"
  else
    warn "node $(node -v) — the project pins Node $ADP_NODE_MAJOR (.nvmrc, CI, Dockerfile)"
    hint "version skew between local and CI is a known source of 'works here, fails there'"
    hint "with fnm or nvm installed: 'fnm use' / 'nvm use' in the repo root"
  fi
else
  fail "node not found — Node $ADP_NODE_MAJOR required"
fi

have npm && ok "npm $(npm -v)" || fail "npm not found"

# conformance/run.sh needs both: curl to fetch the pinned gh release and to poll
# health, openssl to mint the throwaway TLS cert that gh insists on.
have curl && ok "curl present" || fail "curl not found (needed by conformance/run.sh)"
have openssl && ok "openssl present" || fail "openssl not found (needed by conformance/run.sh)"

# Docker's only job in this repo's test loop is provisioning Postgres for
# `make up`. Nothing in the suite talks to a container — the tests talk to a
# DSN. So a machine that already has a reachable Postgres does not need Docker
# at all, and calling that a FAIL made `make doctor` unusable exactly where it
# is most useful: a container or cloud sandbox with a distro Postgres and no
# daemon, and equally a developer who runs Postgres natively on Windows.
#
# A TCP connect rather than a real handshake — this only has to distinguish
# "you have a database endpoint, Docker is not your blocker" from "you have
# neither". The database section below reports on the DSN itself. Uses node,
# which is already a hard requirement above, so this adds no new dependency.
db_reachable() {
  [ -n "${DATABASE_URL:-}" ] || return 1
  node -e '
    const net = require("node:net");
    let u; try { u = new URL(process.env.DATABASE_URL); } catch { process.exit(1); }
    const sock = net.connect({ host: u.hostname, port: Number(u.port) || 5432 });
    sock.setTimeout(3000);
    const bad = () => { sock.destroy(); process.exit(1); };
    sock.on("connect", () => { sock.end(); process.exit(0); });
    sock.on("error", bad);
    sock.on("timeout", bad);
  ' >/dev/null 2>&1
}

section "docker"
docker_state
docker_status=$?
if [ "$docker_status" = "0" ]; then
  ok "docker daemon reachable ($(docker version --format '{{.Server.Version}}' 2>/dev/null))"
  if docker compose version >/dev/null 2>&1; then
    ok "docker compose $(docker compose version --short 2>/dev/null)"
  else
    fail "'docker compose' (v2) not available"
    hint "the legacy 'docker-compose' v1 binary is not supported by deploy/docker-compose.yml"
  fi
elif db_reachable; then
  info "docker unavailable — and not needed: DATABASE_URL already points at a reachable Postgres"
  hint "'make up' provisions Postgres via docker; you have one, so skip it"
  hint "bash scripts/dev/env.sh \"\$DATABASE_URL\"   # writes .env.test against it"
  hint "then 'make test' / 'make conformance' / 'make acceptance' as usual"
elif [ "$docker_status" = "1" ]; then
  fail "docker binary found, but the daemon is unreachable — and no reachable DATABASE_URL to fall back on"
  hint "if using Docker Desktop: start it, and enable WSL integration for this distro"
  hint "Settings -> Resources -> WSL integration (a GUI toggle; there is no CLI for it)"
  hint "or bring your own Postgres and point scripts/dev/env.sh at its DSN"
else
  fail "docker not found in this distro — and no reachable DATABASE_URL to fall back on"
  hint "either enable Docker Desktop's WSL integration for this distro, or"
  hint "install a distro-local engine: sudo apt-get install -y docker.io && sudo service docker start"
  hint "or bring your own Postgres and point scripts/dev/env.sh at its DSN"
fi

section "dependencies"
# One definition of "is this tree present and current" (lib.sh), shared with
# the gate in `make test-all`. What differs is what each does about the answer:
# here it is advice, there it is a refusal.
#
# The severities are not uniform, and were not before this loop existed.
# `server` is the whole suite; the rest are one target each, and a
# machine that only ever runs `make test-unit` is fine without them.
for pkg in $ADP_DEP_PACKAGES; do
  case "$(adp_dep_state "$pkg")" in
  ok) ok "$pkg/node_modules present" ;;
  stale)
    warn "$pkg/node_modules was installed from a different package-lock.json"
    hint "'make deps' — CI installs from the lockfile, so this tree is not what CI tests"
    ;;
  missing)
    if [ "$pkg" = "server" ]; then
      fail "server/node_modules missing"
    elif [ "$pkg" = "server/web" ]; then
      warn "server/web/node_modules missing — the UI will not build"
      hint "main.ts silently skips serving /ui/* when server/web/dist is absent, so"
      hint "web UI checks would pass against a UI that was never built"
    else
      warn "$pkg/node_modules missing — 'make $(basename "$pkg")' (part of test-all) will fail"
    fi
    hint "make deps"
    ;;
  esac
done

section "database"
if [ -n "${DATABASE_URL:-}" ]; then
  ok "DATABASE_URL is set"
  # "Set" was the whole check, which is the same partial-run trap one level
  # down: a DSN pointing at a Postgres that is not there produces a wall of
  # connection errors attributed to whichever suite happened to run first.
  if db_reachable; then
    ok "the DSN's host:port accepts connections"
    info "e2e tier will run"
  else
    fail "nothing is listening at the DSN's host:port"
    hint "DATABASE_URL=$DATABASE_URL"
    hint "'make up' to provision one, or start your own Postgres"
  fi
else
  warn "DATABASE_URL is not set — the entire e2e tier will be SKIPPED"
  hint "a skipped e2e tier still exits 0; that is the partial-run trap"
  hint "export DATABASE_URL=$ADP_DEFAULT_DATABASE_URL"
  hint "or set ADP_REQUIRE_DB=1 to make the skip a hard failure instead"
fi

section "port conflicts"
port_holder() {
  if have ss; then
    ss -tlnp 2>/dev/null | awk -v p=":$1\$" '$4 ~ p {print; exit}'
  elif have lsof; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | sed -n '2p'
  fi
}
for port in "$ADP_SERVER_PORT" "$ADP_POSTGRES_PORT"; do
  holder="$(port_holder "$port")"
  if [ -n "$holder" ]; then
    if [ "$port" = "$ADP_POSTGRES_PORT" ]; then
      info "port $port in use (expected if your Postgres is already up)"
    else
      warn "port $port is already in use"
      hint "$holder"
      hint "a second process on the server port is the classic false bug: a route that"
      hint "provably exists in the source 404s because something else answered"
    fi
  else
    info "port $port free"
  fi
done

section "stale containers"
if docker_state; then
  # The production-shaped compose stack uses restart: unless-stopped, so these
  # come back on their own after a Docker restart and answer on the dev ports
  # with a months-old image built from whatever branch was checked out then.
  stale="$(docker ps --filter "name=deploy-server-1" --format '{{.Names}} ({{.Status}})' 2>/dev/null)"
  if [ -n "$stale" ]; then
    fail "the production-image server container is running: $stale"
    hint "it serves a stale built image, not your checkout — stop it before testing"
    hint "docker stop deploy-server-1"
  else
    ok "no stale deploy-server-1 container"
  fi
  leftovers="$(docker ps -aq --filter "name=${ADP_TEST_PROJECT_PREFIX}" 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$leftovers" != "0" ]; then
    warn "$leftovers leftover ${ADP_TEST_PROJECT_PREFIX}-* container(s) from a previous run"
    hint "bash scripts/dev/verify-clean.sh   # for the full inventory"
  else
    ok "no leftover ${ADP_TEST_PROJECT_PREFIX}-* containers"
  fi
else
  info "skipped (docker unavailable)"
fi

adp_summary "doctor"
