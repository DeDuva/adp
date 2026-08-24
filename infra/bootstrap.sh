#!/usr/bin/env bash
# One-time bootstrap for the ADP dev rung.
#
# Terraform cannot create the bucket that holds its own state, and should not
# hold secret material in that state at all. This script handles both, plus the
# two APIs that must be on before Terraform can enable anything else. Run it
# once; everything after it is `terraform apply`.
#
# Safe to re-run: every step checks for an existing resource first, and secret
# values are never regenerated once set (that would invalidate every signature
# the instance has already produced).
#
# Usage:
#   ./infra/bootstrap.sh <project-id> [billing-account-id]
set -euo pipefail

PROJECT_ID="${1:-}"
BILLING_ACCOUNT="${2:-}"
REGION="${REGION:-us-central1}"

if [ -z "$PROJECT_ID" ]; then
  echo "usage: $0 <project-id> [billing-account-id]" >&2
  echo >&2
  echo "  project-id       globally unique, e.g. adp-dev-4f21" >&2
  echo "  billing-account  from 'gcloud billing accounts list'; required if the" >&2
  echo "                   project does not exist yet" >&2
  exit 1
fi

STATE_BUCKET="${PROJECT_ID}-tfstate"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok()  { printf '  \033[32mok\033[0m    %s\n' "$1"; }
skip(){ printf '  --    %s\n' "$1"; }

# --- preflight --------------------------------------------------------------
say "preflight"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "FATAL: gcloud not found. Install the Google Cloud CLI first." >&2
  exit 1
fi
ok "gcloud $(gcloud version 2>/dev/null | head -1 | awk '{print $NF}')"

if ! gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | grep -q .; then
  echo "FATAL: no active gcloud account." >&2
  echo "  Run:  gcloud auth login" >&2
  echo "  Then: gcloud auth application-default login" >&2
  exit 1
fi
ok "authenticated as $(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -1)"

if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then
  echo "FATAL: no application-default credentials — Terraform needs these separately." >&2
  echo "  Run: gcloud auth application-default login" >&2
  exit 1
fi
ok "application-default credentials present"

# --- project ----------------------------------------------------------------
say "project"

if gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  skip "project $PROJECT_ID already exists"
else
  if [ -z "$BILLING_ACCOUNT" ]; then
    echo "FATAL: project $PROJECT_ID does not exist and no billing account was given." >&2
    echo "  Available billing accounts:" >&2
    gcloud billing accounts list --format='  value(name,displayName)' >&2 || true
    echo "  Re-run: $0 $PROJECT_ID <billing-account-id>" >&2
    exit 1
  fi
  gcloud projects create "$PROJECT_ID" --name="ADP dev"
  ok "created project $PROJECT_ID"
fi

if [ -n "$BILLING_ACCOUNT" ]; then
  if gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null | grep -qi true; then
    skip "billing already linked"
  else
    gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
    ok "linked billing account $BILLING_ACCOUNT"
  fi
else
  if ! gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null | grep -qi true; then
    echo "FATAL: project $PROJECT_ID has no billing enabled, and no billing account was given." >&2
    exit 1
  fi
  skip "billing already linked"
fi

# --- APIs Terraform needs before it can enable the rest ---------------------
say "bootstrap APIs"
for api in serviceusage.googleapis.com cloudresourcemanager.googleapis.com secretmanager.googleapis.com; do
  if gcloud services list --enabled --project="$PROJECT_ID" --format='value(config.name)' 2>/dev/null | grep -qx "$api"; then
    skip "$api already enabled"
  else
    gcloud services enable "$api" --project="$PROJECT_ID"
    ok "enabled $api"
  fi
done

# --- Terraform state bucket -------------------------------------------------
say "terraform state"

if gcloud storage buckets describe "gs://${STATE_BUCKET}" --project="$PROJECT_ID" >/dev/null 2>&1; then
  skip "gs://${STATE_BUCKET} already exists"
else
  # Versioning matters: it is the only way back from a corrupted or truncated
  # state file, and state corruption is the failure mode that actually hurts.
  gcloud storage buckets create "gs://${STATE_BUCKET}" \
    --project="$PROJECT_ID" \
    --location="$REGION" \
    --uniform-bucket-level-access
  gcloud storage buckets update "gs://${STATE_BUCKET}" --versioning
  ok "created gs://${STATE_BUCKET} (versioned)"
fi

# --- secrets ----------------------------------------------------------------
# Created here rather than in Terraform so no secret material ever lands in
# Terraform state. See infra/dev/secrets.tf for the full reasoning.
say "secrets"

ensure_secret() {
  local name="$1" generator="$2"
  if gcloud secrets describe "$name" --project="$PROJECT_ID" >/dev/null 2>&1; then
    skip "$name already exists (value left untouched)"
    return
  fi
  gcloud secrets create "$name" --project="$PROJECT_ID" --replication-policy=automatic
  eval "$generator" | gcloud secrets versions add "$name" --project="$PROJECT_ID" --data-file=-
  ok "created $name"
}

# SIGNING_KEY is the root of the provenance claim (
# §4). core/signing.ts derives an Ed25519 key deterministically via
# SHA-256(SIGNING_KEY), so any sufficiently random string works — but once the
# instance has signed anything, changing this value changes the server's
# identity and orphans every signature made under the old one.
ensure_secret adp-dev-signing-key 'openssl rand -hex 32'

# AES-256-GCM key for mirror credentials and both webhook-signing secrets
# (core/mirror-crypto.ts).
ensure_secret adp-dev-mirror-credential-key 'openssl rand -hex 32'

# Hex, so it needs no percent-encoding inside DATABASE_URL.
ensure_secret adp-dev-postgres-password 'openssl rand -hex 24'

# --- next steps -------------------------------------------------------------
say "next"
cat <<EOF
  Bootstrap complete. Now:

    cd infra/dev
    cp terraform.tfvars.example terraform.tfvars
    \$EDITOR terraform.tfvars          # set project_id, hostname, owner_email

    terraform init -backend-config="bucket=${STATE_BUCKET}"
    terraform plan
    terraform apply

  Then point DNS at the address 'terraform output static_ip' prints, and watch
  the first boot with 'terraform output -raw startup_log_command'.
EOF
