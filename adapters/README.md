# Scanner-as-gate adapters

M2: any CLI scanner can drop into ADP's gate runner without ADP running it.
An adapter is a small script that takes a scanner's own output (SARIF, or the tool's native JSON),
translates it to a typed verdict, and reports it to the substrate that actually attests it:

```
scanner output (SARIF / native JSON) → adapter → POST /api/v3/repos/{owner}/{repo}/gates → DSSE-signed evidence
```

ADP never runs the scanner — this is the receiving and attestation end, the same division of labor
as GitHub's own Checks API (`server/src/http-rest/gates.ts`'s comment). Two reference implementations
prove the contract generalizes:

| Adapter | Input format | Why this one |
|---|---|---|
| [`wizcli/`](wizcli/) | SARIF | the reference adapter (SAST, SCA, secrets, IaC in one tool) |
| [`osv-scanner/`](osv-scanner/) | its own native JSON, not SARIF | proves the interface isn't SARIF-only |

## Writing a new adapter

1. Run the scanner yourself, producing SARIF or the tool's native JSON on disk. Adapters don't invoke
   the scanner — CLI flags, licensing, and auth vary per tool and per plan; keeping that step external
   is what lets an adapter stay small and honest about what it actually verified.
2. Parse the output into `{ status: "success" | "failure", summary: string }` — `adapters/lib/sarif.mjs`
   and `adapters/lib/osv-json.mjs` are the two examples so far.
3. Call `adapters/lib/report.mjs`'s `reportGate({ serverUrl, token, owner, repo, sha, name, status, summary })`.

Every adapter here follows the same CLI shape:

```bash
node adapters/<tool>/run.mjs --<input-flag> <path> --repo <owner>/<repo> [--sha <sha>] \
  [--server <url>] [--token <token>] [--gate-name <name>]
```

`--sha` defaults to `git rev-parse HEAD`; `--server`/`--token` default to `ADP_SERVER_URL`/`ADP_TOKEN`
— the same environment variables the `adp` CLI (`cli/`) reads, and the same bearer-token auth every
other client uses against `server/src/http-rest/gates.ts`.

## wizcli

```bash
wizcli scan dir . --types Terraform --policies "Default IaC policy" --sarif-output-file wiz-results.sarif
node adapters/wizcli/run.mjs --sarif wiz-results.sarif --repo acme/widget --sha "$(git rev-parse HEAD)"
```

The `wizcli scan` invocation above (subcommand, `--types`, `--policies`, `--sarif-output-file`) is
Wiz's own documented flag, not a guess — but the right values for `--types`/`--policies` depend on
your Wiz account's configuration, which this repo has no license to verify against. Run the scan
yourself per your own Wiz setup; the adapter only needs the resulting SARIF file.

## osv-scanner

```bash
osv-scanner scan -L package-lock.json --format json > osv-results.json
node adapters/osv-scanner/run.mjs --json osv-results.json --repo acme/widget --sha "$(git rev-parse HEAD)"
```

Open source, no license needed — this leg is fully testable end to end, unlike wizcli's.
