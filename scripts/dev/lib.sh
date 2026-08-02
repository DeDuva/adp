# Logging helpers for scripts/dev/*, on top of the shared constants.
# Sourced, never executed — the caller owns `set -euo pipefail`.
#
# This file defines short, generic function names (fail, info, warn, ok). Do not
# source it into a script that has its own — source scripts/dev/config.sh
# instead, which is constants only.
#
# See docs/test-environment-automation.md for what these scripts are for.

# shellcheck source=scripts/dev/config.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config.sh"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  _c_red=$'\033[31m'; _c_yellow=$'\033[33m'; _c_green=$'\033[32m'
  _c_dim=$'\033[2m'; _c_bold=$'\033[1m'; _c_off=$'\033[0m'
else
  _c_red=""; _c_yellow=""; _c_green=""; _c_dim=""; _c_bold=""; _c_off=""
fi

# Counters the caller reports on at the end.
ADP_FAILURES=0
ADP_WARNINGS=0

section() { printf '\n%s== %s ==%s\n' "$_c_bold" "$*" "$_c_off"; }
ok()      { printf '  %sok%s    %s\n' "$_c_green" "$_c_off" "$*"; }
info()    { printf '  %s--%s    %s\n' "$_c_dim" "$_c_off" "$*"; }
warn()    { printf '  %swarn%s  %s\n' "$_c_yellow" "$_c_off" "$*"; ADP_WARNINGS=$((ADP_WARNINGS + 1)); }
fail()    { printf '  %sFAIL%s  %s\n' "$_c_red" "$_c_off" "$*"; ADP_FAILURES=$((ADP_FAILURES + 1)); }
hint()    { printf '        %s%s%s\n' "$_c_dim" "$*" "$_c_off"; }

have() { command -v "$1" >/dev/null 2>&1; }

# `docker` can exist on PATH while the daemon is unreachable — the common WSL
# case when Docker Desktop is closed or its WSL integration is off for this
# distro. Callers need to tell those apart, so this returns distinct codes:
#   0 = usable, 1 = binary present but daemon unreachable, 2 = no binary.
docker_state() {
  have docker || return 2
  docker info >/dev/null 2>&1 || return 1
  return 0
}

# Report the final tally and exit accordingly. Warnings never fail a run.
adp_summary() {
  local what="$1"
  printf '\n'
  if [ "$ADP_FAILURES" -gt 0 ]; then
    printf '%s%s: %d failure(s), %d warning(s)%s\n' \
      "$_c_red" "$what" "$ADP_FAILURES" "$ADP_WARNINGS" "$_c_off"
    return 1
  fi
  if [ "$ADP_WARNINGS" -gt 0 ]; then
    printf '%s%s: ok, with %d warning(s)%s\n' \
      "$_c_yellow" "$what" "$ADP_WARNINGS" "$_c_off"
    return 0
  fi
  printf '%s%s: ok%s\n' "$_c_green" "$what" "$_c_off"
  return 0
}
