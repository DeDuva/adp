# `adp-runner` — the gate runner

Polls `/api/adp/gate-jobs/claim`, executes the job in an isolated container — network denied, no
host mounts, no ambient secrets, resource caps — and reports the result through the same signed
path any external reporter uses.

**The reference is the root [`README.md`](../README.md)**, under *Evidence, and who executes it*,
and [`docs/self-hosting.md`](../docs/self-hosting.md) §4 for where it belongs in a deployment.

```bash
npm ci && npm run build
```

Then start it through the CLI, which is the supported entry point — this package declares no `bin`
of its own, because the token and the host acknowledgement below are not things to leave to a bare
`node dist/main.js`:

```bash
adp runner up --here --token <runner-token>    # or ADP_RUNNER_TOKEN
```

**Run it on a host that holds nothing you care about.** It mounts the Docker socket, and a mounted
daemon socket is root on the machine it is mounted from — for a container whose image and commands
are named by whoever can push an `adp.yaml`. That is why `--here` exists: the flag is the
acknowledgement, not a formality. Its token is scoped to `runner` and nothing else; do not reuse a
login token.

It is a pure HTTP client — no `server/` import, no database credential, no signing key — so it can
live on its own node, which is the point.

```bash
npm run typecheck && npm test    # or `make runner` from the repository root
```

Needs a real Docker daemon: the isolation claims are asserted against one rather than mocked.
