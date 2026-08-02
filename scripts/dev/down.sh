#!/usr/bin/env bash
# Tear down the ephemeral test stack and verify nothing leaked.
#
#   bash scripts/dev/down.sh          # this checkout's stack, per .env.test
#   bash scripts/dev/down.sh --all    # every adp-test-* project on this machine
#
# --all is the recovery path: a run killed hard enough to skip its trap leaves
# a project behind that no .env.test records, and the next `make up` mints a new
# project name rather than finding it. Those are exactly the orphans that
# accumulate until something mysterious breaks.
set -uo pipefail

# shellcheck source=scripts/dev/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

COMPOSE_FILE="$ADP_REPO_ROOT/deploy/docker-compose.test.yml"
ENV_FILE="$ADP_REPO_ROOT/.env.test"
ALL=0
[ "${1:-}" = "--all" ] && ALL=1

compose_down() {
  local project="$1"
  # -v is the point: the test stack has no named volumes by design, but an
  # anonymous one created by an older compose file version would otherwise
  # survive and be silently reattached.
  if docker compose -p "$project" -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1; then
    ok "removed project $project"
  else
    fail "could not fully remove project $project"
  fi
}

section "compose stacks"
if ! docker_state; then
  warn "docker unavailable — skipping container teardown"
else
  projects=""
  if [ "$ALL" = "1" ]; then
    # Enumerated from container labels rather than `docker compose ls`, which
    # only reports projects whose compose file it can still resolve — orphans
    # from a deleted worktree would be invisible.
    projects="$(docker ps -a --filter "label=com.docker.compose.project" \
      --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null \
      | grep "^${ADP_TEST_PROJECT_PREFIX}" | sort -u)"
  elif [ -f "$ENV_FILE" ]; then
    projects="$(grep '^ADP_TEST_PROJECT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"
  fi

  if [ -z "$projects" ]; then
    if [ "$ALL" = "1" ]; then
      ok "no ${ADP_TEST_PROJECT_PREFIX}-* projects running"
    else
      info "no project recorded in .env.test"
      hint "bash scripts/dev/down.sh --all   # to sweep orphans from crashed runs"
    fi
  else
    for p in $projects; do compose_down "$p"; done
  fi
fi

section "generated files"
for target in "$ENV_FILE" "$ADP_REPO_ROOT/.adp-test"; do
  if [ -e "$target" ]; then
    rm -rf "$target" && ok "removed ${target#"$ADP_REPO_ROOT"/}"
  else
    info "${target#"$ADP_REPO_ROOT"/} already absent"
  fi
done

# The whole reason teardown exists is to be able to assert it worked. Running
# the check here rather than trusting the removals above is what makes "make
# down" a guarantee instead of a hope.
printf '\n'
bash "$ADP_REPO_ROOT/scripts/dev/verify-clean.sh"
