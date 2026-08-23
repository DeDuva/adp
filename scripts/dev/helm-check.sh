#!/usr/bin/env bash
# Lint and render helm/adp, including the combinations that are supposed to be
# refused.
#
# A chart is only ever wrong at render time: `helm lint` reads the templates,
# but a missing `required`, a bad indent inside a conditional, or a value that
# only appears under `runner.enabled=true` is invisible until something asks
# for that combination. So this renders each branch and checks what came out.
#
# The refusal cases are half the point. The chart deliberately fails to render
# rather than inventing a signing key, guessing a database, or putting the gate
# runner on an unspecified node — and a refusal that quietly stopped refusing
# would be the most expensive kind of regression here, since each one exists to
# stop an operator losing something they cannot get back.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

CHART=helm/adp
KEY_A="0000000000000000000000000000000000000000000000000000000000000001"
KEY_B="0000000000000000000000000000000000000000000000000000000000000002"
BASE=(--set "secrets.signingKey=${KEY_A}" --set "secrets.mirrorCredentialKey=${KEY_B}")

pass() { printf '  \033[32mok\033[0m    %s\n' "$*"; }
fail() { printf '\033[31mHELM FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

if ! command -v helm >/dev/null 2>&1; then
	if [ "${ADP_REQUIRE_HELM:-0}" = "1" ]; then
		fail "helm is not installed and ADP_REQUIRE_HELM=1 — CI must never turn this check into a silent pass"
	fi
	printf '  \033[2m--\033[0m    helm not installed, skipping chart checks (set ADP_REQUIRE_HELM=1 to make this fatal)\n'
	exit 0
fi

printf '\033[1m== helm: %s ==\033[0m\n' "$(helm version --short)"

helm lint "$CHART" "${BASE[@]}" >/dev/null || fail "helm lint"
pass "lint"

# Renders that must succeed, one per branch that changes the output.
render() {
	local name="$1"
	shift
	helm template adp "$CHART" "$@" >"/tmp/adp-helm-${name}.yaml" 2>"/tmp/adp-helm-${name}.err" \
		|| { cat "/tmp/adp-helm-${name}.err" >&2; fail "render '${name}'"; }
	pass "renders: ${name}"
}

render defaults "${BASE[@]}"
render ingress "${BASE[@]}" --set ingress.enabled=true --set ingress.tls.enabled=true --set ingress.tls.secretName=adp-tls
render external-db "${BASE[@]}" --set postgres.enabled=false --set externalDatabase.url=postgres://u:p@db:5432/adp
render existing-secret --set secrets.existingSecret=my-secret --set externalDatabase.url=postgres://u:p@db:5432/adp
render no-persistence "${BASE[@]}" --set persistence.enabled=false
render runner "${BASE[@]}" --set runner.enabled=true --set runner.token=t --set runner.nodeSelector.adp\\.io/gate-runner=true

# Renders that must FAIL, each with the reason an operator needs to read.
refuses() {
	local name="$1" expect="$2"
	shift 2
	local out
	if out=$(helm template adp "$CHART" "$@" 2>&1); then
		fail "'${name}' rendered successfully — it must refuse"
	fi
	grep -q "$expect" <<<"$out" || fail "'${name}' refused, but without mentioning '${expect}':
${out}"
	pass "refuses: ${name}"
}

refuses "a missing signing key" "secrets.signingKey is required"
refuses "a missing at-rest key" "secrets.mirrorCredentialKey is required" --set "secrets.signingKey=${KEY_A}"
refuses "no database of any kind" "ADP does not run without Postgres" "${BASE[@]}" --set postgres.enabled=false
refuses "a runner with no node named" "runner.nodeSelector is required" "${BASE[@]}" --set runner.enabled=true --set runner.token=t
refuses "a runner with no token" "runner.token" "${BASE[@]}" --set runner.enabled=true --set runner.nodeSelector.dedicated=gates
refuses "tls without a certificate" "ingress.tls.secretName is required" "${BASE[@]}" --set ingress.enabled=true --set ingress.tls.enabled=true
# M4-5: an OIDC client id with no secret renders login routes that 502 on every
# attempt. Refusing at install is where the message can still say what is missing.
refuses "an oidc client with no secret" "oidc.clientSecret is required" "${BASE[@]}" --set oidc.clientId=abc.apps.googleusercontent.com

# M4-5: configured OIDC reaches the container, and the client secret is in the
# Secret rather than the ConfigMap. A credential in a ConfigMap is readable by
# anything that can read the namespace's config, which is a wider audience than
# anything that can read its secrets.
oidc_render=$(helm template adp "$CHART" "${BASE[@]}" \
	--set oidc.clientId=abc.apps.googleusercontent.com \
	--set oidc.clientSecret=super-secret \
	--set oidc.allowedDomains=example.com)
grep -q "OIDC_CLIENT_ID: \"abc.apps.googleusercontent.com\"" <<<"$oidc_render" ||
	fail "configured OIDC did not put OIDC_CLIENT_ID in the ConfigMap"
grep -q "OIDC_ALLOWED_DOMAINS: \"example.com\"" <<<"$oidc_render" ||
	fail "configured OIDC did not put OIDC_ALLOWED_DOMAINS in the ConfigMap"
# if/then, per the note further down: a `grep -q ... && fail` that ends up last
# in the file exits 1 while reporting nothing wrong.
if awk '/^kind: ConfigMap/,/^---/' <<<"$oidc_render" | grep -q "super-secret"; then
	fail "the OIDC client secret rendered into the ConfigMap"
fi
awk '/^kind: Secret/,/^---/' <<<"$oidc_render" | grep -q "OIDC_CLIENT_SECRET" ||
	fail "the OIDC client secret did not render into the Secret"
pass "oidc: settings reach the container, and the client secret is in the Secret"

# The default must remain OFF. An instance that did not ask for login must not
# get routes that accept one.
default_render=$(helm template adp "$CHART" "${BASE[@]}")
if grep -q "OIDC_CLIENT_ID" <<<"$default_render"; then
	fail "OIDC is configured by default — it must be opt-in"
fi
pass "oidc: absent by default"

# Assertions on what the default render actually contains. These are the
# claims docs/self-hosting.md makes; if the chart stops making them true, the
# documentation becomes wrong silently.
DEFAULTS=/tmp/adp-helm-defaults.yaml
grep -q "kind: Deployment" "$DEFAULTS" || fail "default render has no Deployment"
grep -q "kind: PersistentVolumeClaim" "$DEFAULTS" || fail "default render has no PVC — git data would be ephemeral"
grep -q "type: Recreate" "$DEFAULTS" || fail "default render lost the Recreate strategy (ReadWriteOnce + rolling update deadlocks)"
grep -q "node.*dist/db/migrate.js" "$DEFAULTS" || fail "default render has no migration init container"
grep -q "automountServiceAccountToken: false" "$DEFAULTS" || fail "default render mounts a Kubernetes API token ADP has no use for"
pass "default render carries the properties docs/self-hosting.md claims"

# The runner's security posture, checked rather than described
# (docs/pragmatic_mvp.md §4.5: a mounted daemon socket is root on the node, so
# what that pod is handed matters more than anywhere else in the chart).
#
# --show-only, because the assertion is about the runner's own manifests and a
# whole-release render necessarily also contains the server's Secret. The first
# version of this check grepped the full render, "found" SIGNING_KEY in the
# server's Secret, and reported a leak that did not exist.
#
# if/then rather than `grep -q ... && fail`: under `set -e` an && list whose
# left side fails takes the whole script's exit status with it, so the negative
# assertions would have exited 1 without a word the moment they passed.
RUNNER=/tmp/adp-helm-runner-only.yaml
helm template adp "$CHART" "${BASE[@]}" \
	--set runner.enabled=true --set runner.token=t --set runner.nodeSelector.dedicated=gates \
	--show-only templates/runner.yaml >"$RUNNER" 2>/dev/null || fail "could not render templates/runner.yaml alone"

grep -q "adp-runner" "$RUNNER" || fail "runner render does not use the runner image"
grep -q "hostPath" "$RUNNER" || fail "runner render lost the docker socket mount — it cannot execute a gate without one"
grep -q "nodeSelector" "$RUNNER" || fail "runner render lost its nodeSelector — the pod could land on the API server's node"
if grep -q "SIGNING_KEY" "$RUNNER"; then fail "the runner's own manifests carry SIGNING_KEY — it must never hold the signing key"; fi
if grep -q "DATABASE_URL" "$RUNNER"; then fail "the runner's own manifests carry DATABASE_URL — it must never hold a database credential"; fi
pass "the runner holds a docker socket and a scoped token, and neither the signing key nor a database credential"

# The default image tag has to be a tag that release.yml actually publishes. It was
# not: the helper rendered the bare appVersion ("0.5.0") while the workflow pushes
# ${github.ref_name} ("v0.5.0"), so a default `helm install` referenced an image that
# has never existed at any version. Nothing caught it because every existing render
# assertion asked whether the chart produced *a* manifest, not whether the manifest
# pointed at anything real.
#
# scripts/dev/check-release.sh ties appVersion to the served contract version; this
# ties the rendered tag to appVersion. Together they reach from api-version.ts to the
# image an operator pulls.
app_version=$(grep -oE '^appVersion: *"?[^"]+"?' "$CHART/Chart.yaml" | sed 's/^appVersion: *//; s/"//g')
grep -qE "image: *\"?ghcr\.io/deduva/adp:v${app_version}\"?" /tmp/adp-helm-defaults.yaml ||
	fail "default render does not pull ghcr.io/deduva/adp:v${app_version} — the tag release.yml publishes"
grep -qE "image: *\"?ghcr\.io/deduva/adp-runner:v${app_version}\"?" "$RUNNER" ||
	fail "runner render does not pull ghcr.io/deduva/adp-runner:v${app_version} — the tag release.yml publishes"
pass "default image tags are v${app_version}, which is what the release workflow pushes"

# An explicit tag must survive verbatim — an operator pinning one is naming a real
# tag and must not have a "v" stapled onto it.
helm template adp "$CHART" "${BASE[@]}" --set image.tag=sha-abc123 >/tmp/adp-helm-pinned.yaml 2>/dev/null ||
	fail "could not render with an explicit image.tag"
grep -qE "image: *\"?ghcr\.io/deduva/adp:sha-abc123\"?" /tmp/adp-helm-pinned.yaml ||
	fail "an explicit image.tag was not used verbatim"
pass "an explicit image.tag overrides the default untouched"

printf '\033[32m== helm: chart lints, renders, and refuses what it should ==\033[0m\n'
