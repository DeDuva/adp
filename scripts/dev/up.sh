#!/usr/bin/env bash
# Bring up the ephemeral test dependency stack and write .env.test.
#
#   bash scripts/dev/up.sh
#
# Idempotent-ish: if a stack for this project name is already running it is
# reused and .env.test is regenerated against it.
set -euo pipefail

# shellcheck source=scripts/dev/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

COMPOSE_FILE="$ADP_REPO_ROOT/deploy/docker-compose.test.yml"

section "preflight"
# `docker_state; case $?` would abort here under `set -e` before the case ever
# ran, swallowing the diagnostic — a bare command's non-zero return is only
# exempt from -e when it is the condition of if/while/&&/||.
docker_status=0
docker_state || docker_status=$?
case $docker_status in
  0) ok "docker daemon reachable" ;;
  1) fail "docker binary found, but the daemon is unreachable"
     hint "if using Docker Desktop: start it and enable WSL integration for this distro"
     hint "or install a distro-local engine: sudo apt-get install -y docker.io && sudo service docker start"
     exit 1 ;;
  2) fail "docker not found in this distro"
     hint "bash scripts/dev/doctor.sh   # for the full diagnosis"
     exit 1 ;;
esac

# One project per checkout *and* per invocation. The short sha keeps worktrees
# of the same repo apart; the pid keeps concurrent runs in one worktree apart.
# Both matter — the default project name is the directory name, `deploy`, which
# every checkout and every worktree shares (finding 4).
if [ -z "${ADP_TEST_PROJECT:-}" ]; then
  sha="$(git -C "$ADP_REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)"
  ADP_TEST_PROJECT="${ADP_TEST_PROJECT_PREFIX}-${sha}-$$"
fi
export COMPOSE_PROJECT_NAME="$ADP_TEST_PROJECT"
export ADP_TEST_PROJECT
info "compose project: $ADP_TEST_PROJECT"

section "bring-up"
# --wait blocks until every service with a healthcheck reports healthy, and
# exits non-zero if one never does. Without it the DSN would be handed out
# before Postgres could accept connections, which is the classic flaky-first-
# test-in-the-run failure.
if ! docker compose -f "$COMPOSE_FILE" up -d --wait; then
  fail "stack did not become healthy"
  docker compose -f "$COMPOSE_FILE" logs --tail 40 postgres || true
  hint "bash scripts/dev/down.sh   # to clean up the partial stack"
  exit 1
fi
ok "postgres healthy"

section "discovered endpoint"
# `docker compose port` is the only correct way to learn the ephemeral port.
# Output is host:port, and the host half is 0.0.0.0 (or :: on some daemons),
# neither of which is connectable — take the port and dial localhost.
mapping="$(docker compose -f "$COMPOSE_FILE" port postgres 5432)"
host_port="${mapping##*:}"
if [ -z "$host_port" ] || [ "$host_port" = "$mapping" ]; then
  fail "could not parse the mapped port from '$mapping'"
  exit 1
fi
ok "postgres on localhost:$host_port"

DATABASE_URL="postgres://adp:adp@localhost:${host_port}/adp"

section "environment"
bash "$ADP_REPO_ROOT/scripts/dev/env.sh" "$DATABASE_URL"

printf '\n'
ok "stack up — load it with:  set -a; . .env.test; set +a"
hint "make test    # run the suite against it"
hint "make down    # tear it down and verify nothing leaked"
