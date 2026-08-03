#!/usr/bin/env bash
# Startup script for the ADP dev instance.
#
# Runs as root on EVERY boot, not just the first — the instance is stopped and
# started on a schedule (scheduler.tf), so this has to be idempotent. Anything
# that would break on a second run is a bug.
#
# Rendered by Terraform (compute.tf) via templatefile(): $${...} is a literal
# shell variable, and a bare dollar-brace is a Terraform substitution.
set -euo pipefail

exec > >(tee -a /var/log/adp-startup.log) 2>&1
echo "=== adp startup $(date -Is) ==="

PROJECT_ID="${project_id}"
HOSTNAME_FQDN="${hostname}"
GIT_REF="${git_ref}"
REPO_DIR=/opt/adp

# --- dependencies -----------------------------------------------------------
# Docker's own apt repo rather than Ubuntu's docker.io, because the compose v2
# plugin ships from here and deploy/docker-compose.yml is v2 syntax.
if ! command -v docker >/dev/null 2>&1; then
  echo "--- installing docker ---"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git gnupg

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$${VERSION_CODENAME}") stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
fi

# --- source -----------------------------------------------------------------
# The repo is public (docs/adp-project-overview: public since 2026-08-01), so
# this needs no credential. Pull rather than re-clone so the Docker build cache
# and any local state survive a restart.
if [ ! -d "$${REPO_DIR}/.git" ]; then
  echo "--- cloning adp@$${GIT_REF} ---"
  git clone --branch "$${GIT_REF}" https://github.com/DeDuva/adp.git "$${REPO_DIR}"
else
  echo "--- updating adp@$${GIT_REF} ---"
  git -C "$${REPO_DIR}" fetch --prune origin
  git -C "$${REPO_DIR}" checkout "$${GIT_REF}"
  git -C "$${REPO_DIR}" reset --hard "origin/$${GIT_REF}"
fi

# --- secrets ----------------------------------------------------------------
# Read from Secret Manager via the metadata server and the REST API rather than
# gcloud, which is not guaranteed present on the base image. The instance's
# service account is granted secretAccessor on exactly these three secrets
# (secrets.tf) and nothing else.
metadata_token() {
  curl -sf -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])'
}

read_secret() {
  local name="$1" token
  token="$(metadata_token)"
  curl -sf -H "Authorization: Bearer $${token}" \
    "https://secretmanager.googleapis.com/v1/projects/$${PROJECT_ID}/secrets/$${name}/versions/latest:access" \
    | python3 -c 'import sys,json,base64; print(base64.b64decode(json.load(sys.stdin)["payload"]["data"]).decode(), end="")'
}

echo "--- reading secrets ---"
SIGNING_KEY="$(read_secret adp-dev-signing-key)"
MIRROR_CREDENTIAL_KEY="$(read_secret adp-dev-mirror-credential-key)"
POSTGRES_PASSWORD="$(read_secret adp-dev-postgres-password)"

for v in SIGNING_KEY MIRROR_CREDENTIAL_KEY POSTGRES_PASSWORD; do
  if [ -z "$${!v}" ]; then
    echo "FATAL: secret $${v} is empty — did infra/bootstrap.sh run?" >&2
    exit 1
  fi
done

# --- config -----------------------------------------------------------------
# Mirrors deploy/.env.example. Written 0600 and owned by root; the values come
# back from Secret Manager on every boot rather than being persisted anywhere
# else on disk.
#
# The Postgres password is hex (bootstrap.sh uses `openssl rand -hex`), so it
# needs no percent-encoding inside DATABASE_URL.
echo "--- writing deploy/.env ---"
umask 077
cat > "$${REPO_DIR}/deploy/.env" <<EOF
POSTGRES_USER=adp
POSTGRES_PASSWORD=$${POSTGRES_PASSWORD}
POSTGRES_DB=adp
DATABASE_URL=postgres://adp:$${POSTGRES_PASSWORD}@postgres:5432/adp
GIT_ROOT=/data/git
SIGNING_KEY=$${SIGNING_KEY}
MIRROR_CREDENTIAL_KEY=$${MIRROR_CREDENTIAL_KEY}
PUBLIC_URL=https://$${HOSTNAME_FQDN}
PORT=3000
GIT_MAX_PACK_BYTES=524288000
LAND_POLICY_FLOOR=gates_green,one_approval
EOF
chmod 600 "$${REPO_DIR}/deploy/.env"

# --- run --------------------------------------------------------------------
# Caddy provisions its own Let's Encrypt certificate for PUBLIC_URL on first
# start, which requires the DNS A record to already resolve to this instance's
# static IP. If the record is missing, the stack still comes up but TLS stays
# pending — check `docker compose logs caddy`.
echo "--- starting stack ---"
cd "$${REPO_DIR}/deploy"
docker compose up -d --build --remove-orphans

echo "=== adp startup complete $(date -Is) ==="
