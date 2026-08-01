#!/usr/bin/env bash
# Assert that no state has leaked from a previous test run.
#
# Run this at the START of a run as well as the end. Checking only at the end
# tells you that you made a mess; checking at the start refuses to produce a
# result that inherited someone else's mess — which matters more, because a run
# polluted by leftovers reports a *wrong* answer rather than an obviously
# broken one. See docs/test-environment-automation.md.
#
#   bash scripts/dev/verify-clean.sh          # report; exit 1 if anything leaked
#   bash scripts/dev/verify-clean.sh --fix    # remove what it finds, then re-verify
#
# --fix removes containers, volumes and networks carrying the adp-test-* prefix,
# and ADP's own temp directories. It deliberately does NOT kill processes: a
# stray test server and your own `npm run dev` look identical from here, and
# killing the wrong one is worse than reporting it.
set -uo pipefail

# shellcheck source=scripts/dev/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

FIX=0
[ "${1:-}" = "--fix" ] && FIX=1

P="$ADP_TEST_PROJECT_PREFIX"

section "docker resources"
if docker_state; then
  for kind in container volume network; do
    case "$kind" in
      container) ids="$(docker ps -aq --filter "name=$P" 2>/dev/null)" ;;
      volume)    ids="$(docker volume ls -q --filter "name=$P" 2>/dev/null)" ;;
      network)   ids="$(docker network ls -q --filter "name=$P" 2>/dev/null)" ;;
    esac
    if [ -z "$ids" ]; then
      ok "no leaked ${kind}s"
      continue
    fi
    count="$(printf '%s\n' "$ids" | wc -l | tr -d ' ')"
    fail "$count leaked $kind(s) matching '$P'"
    case "$kind" in
      container) docker ps -a --filter "name=$P" --format '        {{.Names}}  {{.Status}}' ;;
      volume)    docker volume ls --filter "name=$P" --format '        {{.Name}}' ;;
      network)   docker network ls --filter "name=$P" --format '        {{.Name}}' ;;
    esac
    if [ "$FIX" = "1" ]; then
      # shellcheck disable=SC2086
      case "$kind" in
        container) docker rm -f $ids >/dev/null 2>&1 ;;
        volume)    docker volume rm -f $ids >/dev/null 2>&1 ;;
        network)   docker network rm $ids >/dev/null 2>&1 ;;
      esac
      info "removed"
      ADP_FAILURES=$((ADP_FAILURES - 1))
    fi
  done

  # Not prefix-matched, so not removed even by --fix — this is the user's own
  # long-lived stack, and stopping it is their call. But it must not be running
  # during a test: it answers on the dev port with a stale built image.
  if [ -n "$(docker ps -q --filter "name=deploy-server-1" 2>/dev/null)" ]; then
    fail "deploy-server-1 is running (stale image on the dev port)"
    hint "docker stop deploy-server-1"
  else
    ok "deploy-server-1 not running"
  fi
else
  warn "docker unavailable — cannot verify container/volume/network state"
fi

section "processes"
# Anything still serving the ADP source, plus the conformance TLS proxy, which
# is backgrounded and survives if a run is killed hard enough to skip its trap.
pattern='(tsx|node).*(src/main\.ts|dist/main\.js|conformance/tls-proxy\.mjs)'
if have pgrep; then
  pids="$(pgrep -f "$pattern" 2>/dev/null)"
  if [ -n "$pids" ]; then
    warn "ADP server/proxy process(es) still running"
    for pid in $pids; do
      hint "pid $pid: $(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-110)"
    done
    hint "not killed automatically — a stray test server and your own 'npm run dev'"
    hint "are indistinguishable from here. Stop the right one, then re-run."
  else
    ok "no stray ADP server processes"
  fi
else
  warn "pgrep unavailable — cannot check for stray processes"
fi

section "temp directories"
# The e2e suites mkdtemp into $TMPDIR and clean up in afterAll; a crashed or
# interrupted run leaves them behind. Disk clutter rather than a correctness
# problem, so this warns rather than fails.
tmp_root="${TMPDIR:-/tmp}"
stale_dirs="$(find "$tmp_root" -maxdepth 1 -type d \
  \( -name 'adp-e2e-*' -o -name 'adp-conformance-*' -o -name "${P}-*" \) 2>/dev/null)"
if [ -n "$stale_dirs" ]; then
  count="$(printf '%s\n' "$stale_dirs" | wc -l | tr -d ' ')"
  warn "$count stale temp director(ies) under $tmp_root"
  printf '%s\n' "$stale_dirs" | head -5 | sed 's/^/        /'
  [ "$count" -gt 5 ] && hint "... and $((count - 5)) more"
  if [ "$FIX" = "1" ]; then
    printf '%s\n' "$stale_dirs" | xargs -r rm -rf
    info "removed"
    ADP_WARNINGS=$((ADP_WARNINGS - 1))
  fi
else
  ok "no stale temp directories"
fi

section "generated files"
# up.sh writes these and down.sh removes them; if they are here at the start of
# a run, a previous teardown did not complete. The DSN inside a stale .env.test
# points at an ephemeral port that no longer exists, which fails in a way that
# looks like a database bug rather than a leftover-file bug.
for target in "$ADP_REPO_ROOT/.env.test" "$ADP_REPO_ROOT/.adp-test"; do
  rel="${target#"$ADP_REPO_ROOT"/}"
  if [ -e "$target" ]; then
    warn "$rel still present (a stack is up, or a teardown was interrupted)"
    if [ "$FIX" = "1" ]; then
      rm -rf "$target"
      info "removed $rel"
      ADP_WARNINGS=$((ADP_WARNINGS - 1))
    else
      hint "make down   # the correct way to remove these"
    fi
  else
    ok "$rel absent"
  fi
done

adp_summary "verify-clean"
