# Shared constants for anything in this repo that needs to agree on a port, a
# DSN, or a naming prefix. Sourced, never executed.
#
# Deliberately contains constants ONLY — no functions, no output, no side
# effects. scripts/dev/lib.sh adds logging helpers on top, but this file stays
# safe to source into a script that has its own `fail()`/`info()` (as
# server/conformance/run.sh does) without silently overriding them.

# Repo root, resolved from this file's location so it works from any cwd and
# from inside a git worktree.
ADP_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The single canonical local-development DSN, shared by .github/workflows/ci.yml
# and server/conformance/run.sh. These had drifted apart
# (docs/test-environment-automation.md, finding 5).
#
# NOT the same as deploy/.env.example's DATABASE_URL, and that is not a bug:
# that one uses the compose service hostname `postgres` and only resolves from
# inside the compose network. Anything running on the host uses this.
ADP_DEFAULT_DATABASE_URL="postgres://adp:adp@localhost:5432/adp"

# The Node version the project is pinned to (.nvmrc, CI's setup-node, deploy/Dockerfile).
ADP_NODE_MAJOR="22"

# Every ephemeral test resource carries this prefix, so verify-clean.sh can
# identify leaked state unambiguously and nothing can collide with the
# production-shaped `deploy` compose project.
ADP_TEST_PROJECT_PREFIX="adp-test"

# The GCP dev environment (infra/dev/). These are the resource names Terraform
# creates, not defaults anyone is free to change locally — env-status.sh has to
# agree with infra/dev/*.tf or it reports on the wrong box. Everything that is
# genuinely per-deployment (project, zone, hostname, retirement date) is read
# from infra/dev/terraform.tfvars instead, which is gitignored.
ADP_DEV_INSTANCE="adp-dev"
ADP_DEV_ADDRESS="adp-dev-ip"
ADP_DEV_START_JOB="adp-dev-start"
ADP_DEV_STOP_JOB="adp-dev-stop"
# Matches variables.tf's defaults; terraform.tfvars may override the zone.
ADP_DEV_DEFAULT_ZONE="us-central1-a"
ADP_DEV_DEFAULT_REGION="us-central1"

# Host ports the stack wants. Used for conflict *reporting* only — Phase 1 moves
# the test stack onto discovered ephemeral ports so conflicts stop mattering.
ADP_SERVER_PORT="${PORT:-3000}"
ADP_POSTGRES_PORT="5432"
