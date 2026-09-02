# Self-hosting ADP

**Status:** built. Two supported paths, a Helm chart
([`helm/adp`](../helm/adp)) and Docker Compose ([`deploy/`](../deploy)), both of which stand up a
working instance from nothing.

This document is the one an operator reads. It says what to run, what the two decisions are that
cannot be defaulted for you, and where the sharp edges genuinely are — rather than pretending a
system that hosts git repositories and executes other people's code has none.

---

## 1. What you are deploying

| Component | Required | What it is |
|---|---|---|
| **server** | yes | The Fastify process: git wire protocol, `/api/v3`, `/api/graphql`, `/api/adp`, and the supervision UI at `/ui/` |
| **Postgres** | yes | Every record that is not a git object. The chart bundles one for evaluation; real deployments point at a managed instance |
| **git storage** | yes | Bare repositories on a filesystem. This is the instance's primary data |
| **ingress / TLS** | in practice | `gh` refuses plain HTTP for any host but github.com, so the GitHub-compatible surface needs a real certificate. On a laptop, §3b gets you a self-signed one and a proxy in front of it |
| **gate runner** | no | Executes `adp.yaml` gates in isolated containers. Off by default; see §4 |

Two properties are worth knowing before you start, because both are products of the design rather
than gaps in the packaging:

**The server is a single writer.** `GIT_ROOT` is a directory of bare repositories and
`git receive-pack` writes to it. `server.replicas` is fixed at 1 in the chart and is not a knob —
a second replica is a second writer against the same refs. Scaling past one instance is a product
change (an object store, M4-8), not a values change, so the chart states the constraint instead of
offering a setting that silently corrupts data.

**`PUBLIC_URL` is part of the record, not a display string.** The server signs evidence with it and
hands it back in clone URLs, so changing it later changes URLs already embedded in landed
provenance. Decide the hostname before the first real change lands.

---

## 2. Helm

```bash
helm install adp ./helm/adp \
  --set secrets.signingKey="$(openssl rand -hex 32)" \
  --set secrets.mirrorCredentialKey="$(openssl rand -hex 32)" \
  --set ingress.enabled=true \
  --set ingress.host=adp.example.com \
  --set ingress.tls.enabled=true \
  --set ingress.tls.secretName=adp-tls
```

Then mint the first token — nothing can be done without one:

```bash
kubectl exec deploy/adp -- node dist/bootstrap.js "you@example.com" --org your-org
```

`--org` makes the identity an admin member of that org and scopes the token to it, which is what
the org policy console (M4-7) reads. Omit it and you get a pre-M4-shaped token scoped to nothing.

### The chart refuses rather than guesses

Six combinations fail to render, each because the alternative is worse than a failed install:

| Refused | Why |
|---|---|
| No `secrets.signingKey` | A generated key is regenerated on the next `helm upgrade` unless something looks the old one up — and a rotated signing key orphans every signature the instance ever produced. `infra/bootstrap.sh` learned this first |
| No `secrets.mirrorCredentialKey` | Same shape: it decrypts mirror credentials and webhook secrets written under the old one |
| No database at all | A default pointing at a Postgres that does not exist produces a crash-looping pod, which is a much worse way to learn this |
| Runner with no `nodeSelector` | See §4. Every possible default names someone else's node |
| Runner with no token | The runner is the one process most likely to be executing something hostile; it does not get an ambient credential |
| TLS enabled with no `secretName` | An ingress that silently serves plaintext is worse than one that will not start |

`scripts/dev/helm-check.sh` (`make helm`, and the `helm` job in CI) asserts each of those refusals
still refuses, and that the default render still carries a PVC, the `Recreate` strategy, the
migration init container, and no Kubernetes API token. A guard rail that quietly stopped guarding
would be the expensive kind of regression here.

### Values worth setting

| Value | Default | Set it when |
|---|---|---|
| `externalDatabase.url` | — | Always, outside evaluation. Turns off the bundled Postgres |
| `persistence.size` | `20Gi` | Your repositories are bigger than that |
| `persistence.existingClaim` | — | You manage the volume yourself |
| `secrets.existingSecret` | — | Your secrets come from a manager, not from `--set` |
| `server.landPolicyFloor` | `gates_green` | The instance-wide floor no org or repo can remove. Add `one_approval` — `"gates_green,one_approval"` — once the instance has a second principal; it is author-independent, so a single-principal instance cannot satisfy it |
| `server.trajectoryRetentionDays` | `90` | Your instance keeps `trajectory.payloads: full` repositories and you want their payloads kept longer — or `0` to keep them indefinitely. §5 |
| `runner.*` | disabled | See §4 |

---

## 3. Docker Compose

The single-VM path, and what
[`infra/dev/`](../infra/dev) provisions on GCP:

```bash
cp deploy/.env.example deploy/.env   # then fill in the two keys and PUBLIC_URL
cd deploy && docker compose up -d --build
```

Caddy terminates TLS and fetches a Let's Encrypt certificate for `PUBLIC_URL`, which means the DNS
record must already resolve to the host before the stack starts. If it does not, everything comes
up but TLS stays pending — `docker compose logs caddy`.

Two notes carried over from the rest of the repo. `deploy/docker-compose.yml` is the *production*
stack and must never be used for local development (`AGENTS.md` explains what breaks). And the
server's port is published on `127.0.0.1` only, so the Ops Agent can scrape `/metrics` without
exposing it to the internet — [`docs/observability.md`](observability.md) §2.

---

## 3b. A local instance, for evaluation

Neither path above is what you want on a laptop, and until #158 there was nothing that was.
`make demo` is ephemeral by design and correct to be — a narrated minute that installs nothing
and leaves nothing — but a visitor who liked it had nowhere to go except the Helm chart.

```bash
make local
```

That brings up Postgres on a named volume, the server from source, and a TLS proxy in front of it
with a self-signed certificate for `localhost`, then prints the token, the URL, and how to trust
the certificate. `make local-down` stops it and keeps the data; `make local` brings it back with
the same keys, the same certificate and the same token. `make local-destroy` is the only thing
that deletes anything.

**The certificate is the reason this exists.** `gh` refuses plain HTTP for any host but
github.com, and no override exists — so the GitHub-compatible plane, which is the whole point of
the compat surface, cannot be exercised against a local instance without one. The machinery had
been written three times (acceptance, conformance, `make demo`) and shipped zero times, because
all three were test fixtures.

Trusting it takes one of two forms, and the script prints both for your platform:

```bash
# per-tool, no root — enough for gh, git and curl
export SSL_CERT_FILE=$PWD/.adp-local/tls/cert.pem
export GIT_SSL_CAINFO=$PWD/.adp-local/tls/cert.pem

# or machine-wide, so browsers accept it too (Debian/Ubuntu)
sudo cp .adp-local/tls/cert.pem /usr/local/share/ca-certificates/adp-local.crt && sudo update-ca-certificates
```

**This is not a production TLS story and must not be read as one.** The certificate is self-signed
for `localhost`, because no CA will ever issue for `localhost`. The server runs from source under
your own user, there is no ingress, no backup, and no second replica. §2 and §3 are the real
deployments; this is a convenience for evaluation and development, and deploying it is not a
supported configuration.

One thing it shares with a real deployment, and the reason it is worth calling out: **the signing
key is minted once and kept**. It is what every signature in that instance's history verifies
against, so an instance that rotated it on each restart would silently orphan every change already
landed on it. `.adp-local/env` holds it, mode 600, and is gitignored.

`scripts/dev/local-smoke.sh` drives the whole thing in CI — up, a landed and evidenced change
through real `gh`, a stop, a restart, and the evidence read back from the restarted instance —
because a supported mode nobody runs is a supported mode that rots.

---

## 4. The gate runner, and why it is off by default

M4-9 built the runner as a pure HTTP client: it polls `/api/adp/gate-jobs/claim`, executes the
gate in a container with the network denied, no host mounts, and CPU/memory/wall-clock caps, and
reports through `/complete`. It holds no database credential and no signing key, and the chart
asserts that in CI.

It also needs a container daemon, and **a mounted daemon socket is root on the node holding it**.
That is why the runner was built to run on a
separate host in the first place. All of that isolation is worth nothing if the runner pod lands on
the node running the API server and holding the signing key.

Kubernetes cannot express "a different host" on your behalf, so the chart requires you to name one
and refuses to render otherwise:

```bash
helm upgrade adp ./helm/adp --reuse-values \
  --set runner.enabled=true \
  --set runner.token="$ADP_RUNNER_TOKEN" \
  --set runner.nodeSelector."adp\.io/gate-runner"=true
```

Label a node that runs gates and nothing else, and keep the API server off it (`server.nodeSelector`
or a taint). The chart can check that you named a node. It cannot check that you named the right
one — that part is yours.

The token must carry **only** the `runner` scope. It is instance-wide by necessity (a runner serves
the whole instance, not one repo), and that is precisely why it should carry nothing else: with it,
a compromised runner host can claim, complete and fetch the checkout of jobs it has claimed, and
nothing more.

If you would rather not give a cluster node a daemon socket at all, run the runner outside the
cluster — a VM with Docker, `deploy/Dockerfile.runner`, and `ADP_SERVER_URL` pointing at your
ingress. That is the topology M4-9 was designed around; the chart supports the in-cluster case
because refusing to would just push people into a worse improvisation.

---

## 5. Operating it

- **Backups.** The two things to back up are Postgres and `GIT_ROOT`, and they must be consistent
  with each other: an operation log referring to commits a restored git directory does not have is
  a broken instance, not a degraded one. Managed PITR for the database is M4-8/M4-10 and is not
  built yet — until then, back both up together and test the restore.
- **Monitoring.** `/metrics` is Prometheus text, unauthenticated by design (an operator's scraper is
  not a repo-scoped resource), and should not be internet-reachable.
  [`docs/observability.md`](observability.md) has dashboards and alerts for GCP; anything that
  scrapes Prometheus works.
- **Upgrades.** `helm upgrade` runs migrations in an init container before the new server starts.
  The deployment strategy is `Recreate`, so there is a short outage by design — a rolling update
  would ask two pods to hold one ReadWriteOnce volume and deadlock instead.
- **Health.** `/healthz` is process liveness; `/readyz` queries Postgres. The chart uses the right
  one for each probe, which is what stops a database blip from restarting a healthy server in a loop.
- **Trajectory retention.** Payloads are reduced after **90 days by default**
  (`server.trajectoryRetentionDays`, or `TRAJECTORY_RETENTION_DAYS`). Set `0` to keep them
  indefinitely; an org overrides the instance with `trajectory_retention_days` on
  `PATCH /api/adp/orgs/{id}`, where **null means "inherit"** and `0` means "keep forever" — the two
  are different states on purpose.

  **Reducing a payload is not deleting an event.** The event keeps its sequence, its links, its
  hash, and every typed column — tokens, cost, duration, tool identity, verdict, commit — so a
  reduced run still verifies, and `GET .../runs/{id}/verify` reports `not_retained`: how many events
  in a range it could only take as recorded rather than re-derive from their contents. What that
  costs is worth knowing before you rely on it: for those events the typed columns are no longer
  independently verifiable either, because the hash covering them cannot be recomputed without the
  payload it also covers. A signed checkpoint head past them still pins the prefix, so a wholesale
  rewrite is still caught.

  **Upgrading an existing instance changes behaviour**, which is why the window is generous and the
  override exists. Under the default `trajectory.payloads: structure` a reduced event loses a shape
  whose strings were already replaced by their byte counts (`adp.yaml`); a repository that opted
  into `payloads: full` is exactly the one whose org should set a window of its own. Each sweep
  records a `trajectory.reduce` operation, so a payload that is gone can be accounted for rather
  than merely missed, and the org console shows what has been reduced and what is due next.

---

## 6. What this does not cover yet

- **Object storage.** Gate logs are inline in Postgres with a size cap, and evidence bundles are
  assembled on read. `externalDatabase.url` has no object-store sibling because M4-8 is not built —
  it is blocked on a budget decision, not a design one ([`PLAN.md`](../PLAN.md)).
- **Backup/PITR as a supported procedure.** M4-10, and gated on M4-8. The exit criterion is an
  executed restore drill, not a documented one, so nothing is claimed here until that has been run.
- **Horizontal scale.** One writer, per §1.
- **SSO enforcement and SCIM.** M4-6. OIDC *login* ships (§8); what is not built is an org-level
  "everyone here must use SSO" rule, and directory provisioning/deprovisioning. SCIM is deferred by
  decision rather than blocked — it is parked until a procurement conversation asks for it.

---

## 7. OIDC login

Optional, and **off unless you configure it**: with no client credentials the `/auth/oidc` routes do
not exist at all. Token auth is the identity story; this is additive to it.

### Setting it up against Google

1. In Google Cloud, create an **OAuth 2.0 Client ID** of type *Web application*.
2. Add exactly one Authorized redirect URI: `$PUBLIC_URL/auth/oidc/callback`. It must match what the
   server derives from `PUBLIC_URL`, including scheme and any trailing path — Google compares it
   byte for byte.
3. Set `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` (Helm: `oidc.clientId`, and
   `oidc.clientSecretName` naming a secret with an `OIDC_CLIENT_SECRET` key).

### The decision you actually have to make

`OIDC_ALLOWED_DOMAINS` decides who may create an account by logging in, and **it is empty by
default, which means nobody**. A verified Google account with no existing link is refused.

| Setting | Who can log in |
|---|---|
| unset (default) | Only identities an operator has already linked. Fails closed |
| `example.com` | Anyone with a verified `@example.com` Google account, provisioned on first login |
| a broad or public domain | Anyone. This is an open door — do not |

An existing link always wins over the allowlist, so narrowing the list later does not lock out
people who already have accounts. That is deliberate: an allowlist is a provisioning rule, not a
revocation mechanism. To actually remove someone, revoke their tokens and delete their
`external_identities` row.

A login mints a token with `repo:read` and `repo:write`, expiring after `OIDC_TOKEN_TTL_MINUTES`
(default 12 hours). **`admin` is not reachable from this route by any input** — creating an admin
stays a host-level `bootstrap.js` action, the same trust level the first admin needed anyway. The
token is scoped to the person's org when they belong to exactly one, and to no org when they belong
to none or to several: ambiguity resolves to no access rather than to a guess.

Every login writes an `auth.login` operation carrying the issuer, the subject, and whether an
identity was created — never the token. "Who logged in, when, via which provider" is a history
query, like everything else here.

### The real-Google acceptance check

The automated suite (`server/test/e2e-oidc.test.ts`) runs the whole flow against a real OpenID
provider on localhost — real RSA keys, real JWKS, real signatures — because what must not be faked
is the protocol. What it cannot exercise is Google specifically. Run this once against the live
provider after configuring an instance:

```
1. Open $PUBLIC_URL/auth/oidc/start in a browser.
2. Expect Google's consent screen, and a URL carrying code_challenge_method=S256.
3. Approve. Expect a JSON body with a token, your principal, and scopes
   ["repo:read","repo:write"] — and NOT "admin".
4. Use that token:  curl -H "Authorization: Bearer $TOKEN" $PUBLIC_URL/user
5. Confirm the audit trail:
   GET /api/adp/orgs/{org}/audit-log  → an auth.login entry naming
   accounts.google.com and your subject, with no token in it.
6. Negative: log in from an account outside OIDC_ALLOWED_DOMAINS. Expect 403,
   and no new row in external_identities.
```

Step 6 is the one worth doing carefully. Steps 1–5 fail loudly when they fail; an allowlist that
silently admits everyone does not.

---

## 8. Verifying a fresh install

What was actually run against this chart, on a throwaway cluster, before it shipped:

```
helm install → pods Running, PVCs Bound
GET /healthz  200
GET /readyz   200        (so it reached Postgres)
GET /ui/      200        (the supervision UI, including M4-7's org console)
GET /metrics  Prometheus text
node dist/bootstrap.js … --org …   → a token
POST /api/v3/repos/{owner}         → 201
git clone && git push              → the post-receive hook recorded a signed change,
                                     visible in /api/adp/repos/{owner}/{repo}/operations
```

That last line is the one that matters: it is the difference between a chart that renders and an
instance that works. If you are validating your own deployment, that is the sequence to run — the
push, not the health check, is what proves the thing is real.
