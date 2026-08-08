#!/usr/bin/env bash
# Is the adp-dev environment (infra/dev/) healthy right now?
#
# adp-dev redeploys itself from `main` on every scheduled boot, silently, and
# is stopped outside working hours — during which inbound GitHub webhooks are
# dropped and GitHub does not retry indefinitely (docs/environments-plan.md
# §5.2). Both facts are invisible until something that depended on them fails.
# This asks, in one command, and answers from four independent vantage points:
# GCP's view of the instance, DNS, the TLS handshake, and the server's own
# GET /version.
#
# Exit 0 = usable (warnings are advisory). Exit 1 = something is broken.
#
# Degrades on purpose: with no gcloud, or an unauthenticated one, the cloud
# sections warn and skip while every check reachable over plain curl still
# runs. `make doctor` does not require gcloud and neither does this.
set -uo pipefail

# shellcheck source=scripts/dev/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

JSON=0
for arg in "$@"; do
  case "$arg" in
    --json) JSON=1 ;;
    -h|--help)
      cat <<'USAGE'
usage: env-status.sh [--json]

Report the health of the adp-dev environment (infra/dev/).

  --json   one JSON object on stdout, no colour and no summary banner

Configuration is read from infra/dev/terraform.tfvars (gitignored). Override
any of it with ADP_DEV_HOST, ADP_DEV_PROJECT, ADP_DEV_ZONE, ADP_DEV_REGION.

ADP_DEV_URL points the app checks (/healthz, /readyz, /version) somewhere
other than https://<hostname> — a local stack, say. The DNS and TLS checks
still describe the real hostname, since that is what they are about.
USAGE
      exit 0
      ;;
    *) echo "env-status: unknown argument '$arg' (try --help)" >&2; exit 2 ;;
  esac
done

# --- configuration ----------------------------------------------------------
# terraform.tfvars is gitignored — it names a specific project and a specific
# person. It is still the only on-disk record of which box this checkout
# provisioned, so it is the source of truth here, with env overrides for anyone
# working against a different one.
TFVARS="$ADP_REPO_ROOT/infra/dev/terraform.tfvars"

tfvar() {
  [ -f "$TFVARS" ] || return 0
  sed -n -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"?([^\"#]*)\"?[[:space:]]*(#.*)?$/\1/p" "$TFVARS" \
    | head -1 | sed -E 's/[[:space:]]+$//'
}

HOST="${ADP_DEV_HOST:-$(tfvar hostname)}"
PROJECT="${ADP_DEV_PROJECT:-$(tfvar project_id)}"
ZONE="${ADP_DEV_ZONE:-$(tfvar zone)}"; ZONE="${ZONE:-$ADP_DEV_DEFAULT_ZONE}"
REGION="${ADP_DEV_REGION:-$(tfvar region)}"; REGION="${REGION:-$ADP_DEV_DEFAULT_REGION}"
RETIRE_AFTER="$(tfvar retire_after)"
AUTO_SHUTDOWN="$(tfvar auto_shutdown)"; AUTO_SHUTDOWN="${AUTO_SHUTDOWN:-true}"
START_SCHEDULE="$(tfvar start_schedule)"; START_SCHEDULE="${START_SCHEDULE:-0 8 * * 1-5}"
STOP_SCHEDULE="$(tfvar stop_schedule)"; STOP_SCHEDULE="${STOP_SCHEDULE:-0 19 * * 1-5}"
SCHEDULE_TZ="$(tfvar schedule_timezone)"; SCHEDULE_TZ="${SCHEDULE_TZ:-America/Los_Angeles}"
GIT_REF="$(tfvar adp_git_ref)"; GIT_REF="${GIT_REF:-main}"
# Deployed dev is always HTTPS on the hostname Caddy holds the certificate for.
# The override exists so the app checks can be pointed at a stack that is not
# that — a local `make up`, mainly.
BASE_URL="${ADP_DEV_URL:-https://$HOST}"; BASE_URL="${BASE_URL%/}"

# --- output funnel ----------------------------------------------------------
# One call site per check, two renderings. The alternative — a second pass that
# rebuilds the same findings for --json — is how the JSON and the CLI end up
# disagreeing about what is wrong.
JSON_CHECKS=()
CURRENT_SECTION=""

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' | tr -d '\000-\010\013\014\016-\037'
}

# emit <section> <ok|warn|fail|info> <name> <message> [detail]
emit() {
  local sect="$1" status="$2" name="$3" msg="$4" detail="${5:-}"

  if [ "$JSON" = 1 ]; then
    JSON_CHECKS+=("$(printf '{"section":"%s","name":"%s","status":"%s","message":"%s","detail":"%s"}' \
      "$(json_escape "$sect")" "$(json_escape "$name")" "$(json_escape "$status")" \
      "$(json_escape "$msg")" "$(json_escape "$detail")")")
    # warn/fail keep the counters honest without printing; adp_summary is not
    # called in JSON mode but the exit code still comes from these.
    case "$status" in
      fail) ADP_FAILURES=$((ADP_FAILURES + 1)) ;;
      warn) ADP_WARNINGS=$((ADP_WARNINGS + 1)) ;;
    esac
    return
  fi

  if [ "$sect" != "$CURRENT_SECTION" ]; then
    section "$sect"
    CURRENT_SECTION="$sect"
  fi
  case "$status" in
    ok)   ok   "$msg" ;;
    warn) warn "$msg" ;;
    fail) fail "$msg" ;;
    *)    info "$msg" ;;
  esac
  [ -n "$detail" ] && hint "$detail"
  return 0
}

# --- helpers ----------------------------------------------------------------
# `gcloud` can be on PATH while unusable — no active account, or (the common
# WSL case) the Windows Cloud SDK shim, which is on PATH but slow and often
# logged into nothing. Same three-way distinction as lib.sh's docker_state:
#   0 = usable, 1 = present but no active account, 2 = no binary.
gcloud_state() {
  have gcloud || return 2
  timeout 30 gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | grep -q . || return 1
  return 0
}

gc() {
  local args=(timeout 60 gcloud)
  [ -n "$PROJECT" ] && args+=(--project "$PROJECT")
  "${args[@]}" "$@"
}

# Seconds -> "3h12m" / "4d3h" / "12m".
human_duration() {
  local s="$1" d h m
  d=$((s / 86400)); h=$(((s % 86400) / 3600)); m=$(((s % 3600) / 60))
  if [ "$d" -gt 0 ]; then printf '%dd%dh' "$d" "$h"
  elif [ "$h" -gt 0 ]; then printf '%dh%dm' "$h" "$m"
  else printf '%dm' "$m"; fi
}

epoch_of() { date -d "$1" +%s 2>/dev/null; }

json_field() {
  # Flat string field out of a small JSON object, without a jq dependency.
  printf '%s' "$1" | grep -oE "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 \
    | sed -E "s/.*:[[:space:]]*\"([^\"]*)\"/\1/"
}

# Is now inside the start..stop window? Echoes in|out|unknown.
#
# Deliberately handles only the fixed "M H * * <dow>" shape the scheduler
# actually uses. Anything else (a step, a list of hours) reports unknown rather
# than guessing — a wrong window silently turns "expected down" into a failure.
schedule_window() {
  local start="$1" stop="$2" tz="$3"
  local s_min s_hr s_dow e_min e_hr now_dow now_min start_at stop_at
  read -r s_min s_hr _ _ s_dow <<<"$start"
  read -r e_min e_hr _ _ _ <<<"$stop"
  case "$s_min$s_hr$e_min$e_hr" in *[!0-9]*) echo unknown; return ;; esac

  now_dow="$(TZ="$tz" date +%u)"
  now_min=$((10#$(TZ="$tz" date +%H) * 60 + 10#$(TZ="$tz" date +%M)))
  start_at=$((10#$s_hr * 60 + 10#$s_min))
  stop_at=$((10#$e_hr * 60 + 10#$e_min))

  case "$s_dow" in
    \*) : ;;
    [0-9]-[0-9]) [ "$now_dow" -ge "${s_dow%-*}" ] && [ "$now_dow" -le "${s_dow#*-}" ] || { echo out; return; } ;;
    *[!0-9,]*) echo unknown; return ;;
    *) [[ ",$s_dow," == *",$now_dow,"* ]] || { echo out; return; } ;;
  esac

  if [ "$now_min" -ge "$start_at" ] && [ "$now_min" -lt "$stop_at" ]; then echo in; else echo out; fi
}

# "0 19 * * 1-5" -> "19:00"
hhmm() {
  local m h
  read -r m h _ <<<"$1"
  case "$m$h" in *[!0-9]*) printf '%s' "$h:$m"; return ;; esac
  printf '%02d:%02d' "$((10#$h))" "$((10#$m))"
}

# --- preconditions ----------------------------------------------------------
if [ -z "$HOST" ]; then
  emit "config" fail "target" "no dev host configured" \
    "create infra/dev/terraform.tfvars (see terraform.tfvars.example) or set ADP_DEV_HOST"
  if [ "$JSON" = 1 ]; then
    printf '{"checks":[%s],"summary":{"failures":%d,"warnings":%d}}\n' \
      "$(IFS=,; echo "${JSON_CHECKS[*]}")" "$ADP_FAILURES" "$ADP_WARNINGS"
    exit 1
  fi
  adp_summary "env-status"
  exit 1
fi

# --- instance ---------------------------------------------------------------
CLOUD=0
gcloud_state
case $? in
  0) CLOUD=1 ;;
  1) emit "instance" warn "gcloud" "gcloud is installed but has no active account — cloud checks skipped" \
       "gcloud auth login   (app checks below still run over plain curl)" ;;
  2) emit "instance" warn "gcloud" "gcloud not installed — cloud checks skipped" \
       "app checks below still run over plain curl; install the Cloud SDK for the rest" ;;
esac

WINDOW="unknown"
if [ "$AUTO_SHUTDOWN" = "false" ]; then
  WINDOW="in"
  emit "instance" info "schedule" "auto_shutdown is off — the instance is expected up at all hours"
else
  WINDOW="$(schedule_window "$START_SCHEDULE" "$STOP_SCHEDULE" "$SCHEDULE_TZ")"
  tz_abbr="$(TZ="$SCHEDULE_TZ" date +%Z)"
  case "$WINDOW" in
    in)  emit "instance" ok "schedule" "inside scheduler window (stops $(hhmm "$STOP_SCHEDULE") $tz_abbr)" ;;
    out) emit "instance" info "schedule" "outside scheduler window (starts $(hhmm "$START_SCHEDULE") $tz_abbr) — stopped is expected" ;;
    *)   emit "instance" warn "schedule" "cannot read the scheduler window from '$START_SCHEDULE' / '$STOP_SCHEDULE'" \
           "only the fixed 'M H * * <dow>' shape is understood; treating the instance as expected-up" ;;
  esac
  [ "$WINDOW" = "unknown" ] && WINDOW="in"
fi

INSTANCE_STATE="unknown"
LABEL_RETIRE=""
if [ "$CLOUD" = 1 ]; then
  err_file="$(mktemp)"
  desc="$(gc compute instances describe "$ADP_DEV_INSTANCE" --zone "$ZONE" \
    --format="value[separator='|'](status,lastStartTimestamp,labels.retire-after)" 2>"$err_file")"
  if [ -n "$desc" ]; then
    IFS='|' read -r INSTANCE_STATE last_start LABEL_RETIRE <<<"$desc"
    up=""
    if [ -n "$last_start" ]; then
      started="$(epoch_of "$last_start")"
      [ -n "$started" ] && up=" (up $(human_duration $(( $(date +%s) - started ))))"
    fi
    if [ "$INSTANCE_STATE" = "RUNNING" ]; then
      emit "instance" ok "power" "$ADP_DEV_INSTANCE RUNNING$up"
    elif [ "$WINDOW" = "in" ]; then
      emit "instance" fail "power" "$ADP_DEV_INSTANCE $INSTANCE_STATE inside the scheduler window" \
        "the start job should have brought it up — gcloud compute instances start $ADP_DEV_INSTANCE --zone $ZONE"
    else
      emit "instance" ok "power" "$ADP_DEV_INSTANCE $INSTANCE_STATE (as scheduled)"
    fi
  else
    first_err="$(head -1 "$err_file")"
    if grep -qiE "not found|was not found" "$err_file"; then
      emit "instance" fail "power" "$ADP_DEV_INSTANCE not found in $PROJECT/$ZONE" \
        "terraform -chdir=infra/dev apply, or point ADP_DEV_PROJECT/ADP_DEV_ZONE at the right box"
    else
      emit "instance" warn "power" "could not describe $ADP_DEV_INSTANCE" "$first_err"
      CLOUD=0
    fi
  fi
  rm -f "$err_file"

  if [ "$CLOUD" = 1 ] && [ "$AUTO_SHUTDOWN" != "false" ]; then
    for job in "$ADP_DEV_START_JOB" "$ADP_DEV_STOP_JOB"; do
      jd="$(gc scheduler jobs describe "$job" --location "$REGION" \
        --format="value[separator='|'](state,lastAttemptTime,status.code)" 2>/dev/null)"
      if [ -z "$jd" ]; then
        emit "instance" warn "$job" "scheduler job $job not readable" \
          "auto_shutdown is on, so this job is what starts/stops the box"
        continue
      fi
      IFS='|' read -r j_state j_last j_code <<<"$jd"
      when="never run"
      [ -n "$j_last" ] && when="last run $j_last"
      if [ "$j_state" != "ENABLED" ]; then
        emit "instance" fail "$job" "$job is $j_state ($when)" "gcloud scheduler jobs resume $job --location $REGION"
      elif [ -n "$j_code" ] && [ "$j_code" != "0" ]; then
        emit "instance" fail "$job" "$job last attempt failed with status $j_code ($when)"
      else
        emit "instance" ok "$job" "$job enabled, $when"
      fi
    done
  fi
fi

# What the rest of the run assumes about reachability. Knowing the box is
# stopped outside its window turns "unreachable" from a failure into a fact.
EXPECT_UP=1
[ "$INSTANCE_STATE" != "unknown" ] && [ "$INSTANCE_STATE" != "RUNNING" ] && EXPECT_UP=0
[ "$INSTANCE_STATE" = "unknown" ] && [ "$WINDOW" = "out" ] && EXPECT_UP=0

# --- dns + tls --------------------------------------------------------------
resolved=""
if have dig; then
  resolved="$(dig +short A "$HOST" 2>/dev/null | grep -E '^[0-9.]+$' | tail -1)"
else
  resolved="$(getent ahostsv4 "$HOST" 2>/dev/null | awk '{print $1; exit}')"
fi

static_ip=""
[ "$CLOUD" = 1 ] && static_ip="$(gc compute addresses describe "$ADP_DEV_ADDRESS" --region "$REGION" \
  --format="value(address)" 2>/dev/null)"

if [ -z "$resolved" ]; then
  emit "dns + tls" fail "dns" "$HOST does not resolve" \
    "the duckdns A record is set by hand — terraform -chdir=infra/dev output duckdns_update_command"
elif [ -n "$static_ip" ] && [ "$resolved" != "$static_ip" ]; then
  emit "dns + tls" fail "dns" "$HOST -> $resolved, but the static IP is $static_ip" \
    "re-point the duckdns record; Caddy cannot renew its certificate while this is wrong"
elif [ -n "$static_ip" ]; then
  emit "dns + tls" ok "dns" "$HOST -> $resolved (matches static IP)"
elif [ "$CLOUD" = 1 ]; then
  emit "dns + tls" info "dns" "$HOST -> $resolved (address $ADP_DEV_ADDRESS not readable — not compared)"
else
  emit "dns + tls" info "dns" "$HOST -> $resolved (no gcloud — not compared against the static IP)"
fi

if [ "$EXPECT_UP" = 0 ]; then
  emit "dns + tls" info "tls" "certificate not checked (instance is not running)"
else
  cert="$(timeout 20 openssl s_client -connect "$HOST:443" -servername "$HOST" </dev/null 2>/dev/null \
    | openssl x509 -noout -issuer -enddate 2>/dev/null)"
  if [ -z "$cert" ]; then
    emit "dns + tls" fail "tls" "no TLS certificate presented on $HOST:443" \
      "Caddy provisions on first start and needs the A record to resolve — docker compose logs caddy"
  else
    not_after="$(printf '%s' "$cert" | sed -n 's/^notAfter=//p')"
    issuer="$(printf '%s' "$cert" | sed -n 's/.*[/,] *O *= *\([^/,]*\).*/\1/p' | head -1)"
    [ -z "$issuer" ] && issuer="unknown issuer"
    exp="$(epoch_of "$not_after")"
    if [ -z "$exp" ]; then
      emit "dns + tls" warn "tls" "certificate from $issuer, could not parse expiry '$not_after'"
    else
      days=$(( (exp - $(date +%s)) / 86400 ))
      if [ "$days" -lt 0 ]; then
        emit "dns + tls" fail "tls" "certificate from $issuer expired $(( -days )) day(s) ago"
      elif [ "$days" -lt 14 ]; then
        emit "dns + tls" warn "tls" "certificate from $issuer expires in $days days" \
          "Caddy renews at 30 days remaining — if it has not, it is failing"
      else
        emit "dns + tls" ok "tls" "certificate from $issuer valid for $days more days"
      fi
    fi
  fi
fi

# --- app --------------------------------------------------------------------
probe() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$BASE_URL/$1" 2>/dev/null; }

health="$(probe healthz)"
ready="$(probe readyz)"
APP_UP=0
if [ "$health" = "200" ] && [ "$ready" = "200" ]; then
  APP_UP=1
  emit "app" ok "probes" "/healthz 200   /readyz 200 (db reachable)"
elif [ "$health" = "200" ]; then
  APP_UP=1
  emit "app" fail "probes" "/healthz 200   /readyz $ready — the server is up but its database is not" \
    "docker compose -f /opt/adp/deploy/docker-compose.yml logs postgres"
elif [ "$EXPECT_UP" = 0 ]; then
  emit "app" info "probes" "not probed (instance is not running)"
elif [ "$health" = "000" ] || [ -z "$health" ]; then
  emit "app" fail "probes" "$BASE_URL/healthz — no response" \
    "nothing is listening, or TLS/DNS is wrong; the sections above narrow which"
else
  emit "app" fail "probes" "/healthz answered $health, not 200" \
    "something is answering at $BASE_URL, but it is not this server — check docker compose on the box"
fi

if [ "$APP_UP" = 1 ]; then
  version_body="$(curl -s --max-time 15 "$BASE_URL/version" 2>/dev/null)"
  deployed="$(json_field "$version_body" sha)"
  remote="$(timeout 30 git -C "$ADP_REPO_ROOT" ls-remote origin "$GIT_REF" 2>/dev/null | awk 'NR==1{print $1}')"

  if [ -z "$deployed" ]; then
    emit "app" warn "deployed-sha" "GET /version returned no sha — this deploy predates the endpoint" \
      "the box redeploys from origin/$GIT_REF on every boot; restart it to pick /version up"
  elif [ -z "$remote" ]; then
    emit "app" warn "deployed-sha" "deployed ${deployed:0:7}, could not read origin/$GIT_REF to compare"
  elif [ "$deployed" = "$remote" ]; then
    emit "app" ok "deployed-sha" "deployed ${deployed:0:7} == origin/$GIT_REF"
  else
    distance=""
    if git -C "$ADP_REPO_ROOT" cat-file -e "$deployed^{commit}" 2>/dev/null &&
       git -C "$ADP_REPO_ROOT" cat-file -e "$remote^{commit}" 2>/dev/null; then
      n="$(git -C "$ADP_REPO_ROOT" rev-list --count "$deployed..$remote" 2>/dev/null)"
      [ -n "$n" ] && distance=" ($n behind)"
    fi
    emit "app" fail "deployed-sha" "deployed ${deployed:0:7}, origin/$GIT_REF ${remote:0:7}$distance" \
      "the box redeploys on boot — restart it, or gcloud compute ssh $ADP_DEV_INSTANCE --zone $ZONE --tunnel-through-iap"
  fi
fi

# --- derived ----------------------------------------------------------------
# The check this whole script exists for. Nothing above reports it directly:
# a stopped instance looks like a cost saving until you notice a mirror never
# synced, because the delivery GitHub gave up on left no trace on this side.
if [ "$APP_UP" = 1 ]; then
  emit "derived" ok "webhooks" "webhooks deliverable (instance up)"
elif [ "$INSTANCE_STATE" != "unknown" ] && [ "$INSTANCE_STATE" != "RUNNING" ]; then
  emit "derived" warn "webhooks" "inbound GitHub webhooks are being DROPPED (instance $INSTANCE_STATE)" \
    "GitHub does not retry indefinitely; start the box before testing mirror mode"
elif [ "$EXPECT_UP" = 0 ]; then
  emit "derived" warn "webhooks" "inbound GitHub webhooks are being DROPPED (outside the scheduler window)" \
    "GitHub does not retry indefinitely; start the box before testing mirror mode"
else
  emit "derived" warn "webhooks" "webhook deliverability unknown — the server did not answer"
fi

# --- cost -------------------------------------------------------------------
retire="$LABEL_RETIRE"
retire_src="instance label"
if [ -z "$retire" ]; then
  retire="$RETIRE_AFTER"
  retire_src="terraform.tfvars"
fi
if [ -z "$retire" ]; then
  emit "cost" warn "retire-after" "no retirement date recorded" \
    "dev is disposable by design (docs/environments-plan.md §5.2) — set retire_after in terraform.tfvars"
else
  retire_epoch="$(epoch_of "$retire")"
  if [ -z "$retire_epoch" ]; then
    emit "cost" warn "retire-after" "unparseable retirement date '$retire' ($retire_src)"
  else
    days=$(( (retire_epoch - $(date +%s)) / 86400 ))
    if [ "$days" -lt 0 ]; then
      emit "cost" warn "retire-after" "retire-after $retire passed $(( -days )) day(s) ago ($retire_src)" \
        "if the box is not in active use, terraform -chdir=infra/dev destroy — secrets and state survive it"
    else
      emit "cost" info "retire-after" "retire-after $retire, $days day(s) away ($retire_src)"
    fi
  fi
fi

# --- summary ----------------------------------------------------------------
if [ "$JSON" = 1 ]; then
  printf '{"checks":[%s],"summary":{"failures":%d,"warnings":%d}}\n' \
    "$(IFS=,; echo "${JSON_CHECKS[*]}")" "$ADP_FAILURES" "$ADP_WARNINGS"
  [ "$ADP_FAILURES" -gt 0 ] && exit 1
  exit 0
fi

adp_summary "env-status"
