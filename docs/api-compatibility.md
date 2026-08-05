# API compatibility

ADP's claim is that the protocol, not the implementation, is the commitment. That claim only means
something if a consumer can tell which protocol it is talking to — so this document says what the
version number promises, and what it does not.

## Where the version lives

`spec/openapi.yaml` `info.version` is the contract version. `server/src/api-version.ts` holds the
same string in code, and `server/src/api-version.test.ts` fails if the two disagree. There is one
source of truth and a test that keeps it that way; neither can be updated alone.

Every response carries the version in an **`ADP-API-Version`** header — including `401`s and `404`s.
That is deliberate: a client pins the contract before it can authenticate, and a header that only
appeared on successful, authenticated responses would be useless for exactly the case it exists to
catch, which is a client pointed at the wrong instance.

The git smart-HTTP routes are not covered. They hijack the reply and proxy git's own wire protocol
verbatim; that protocol is specified by git, not by ADP.

## What a bump means

Versions are semver over the **wire contract**, not over this codebase. `server/package.json` is
unrelated and stays at `0.0.0`.

| Change | Bump |
|---|---|
| New endpoint, new optional request field, new response field | **minor** |
| New enum value in a response a client is expected to switch on | **minor**, and note it in the release notes |
| Removed or renamed endpoint, path, or field | **major** |
| Field changes type, or an optional request field becomes required | **major** |
| Status code for an existing condition changes | **major** |
| Tightened validation that rejects a request previously accepted | **major** |
| Bug fix that brings behaviour back in line with this spec | **patch** |

The test to apply: **would a client generated against the previous version still work unmodified?**
If no, it is a major bump, regardless of how small the diff looks.

## What is not promised

- **Response field ordering**, and the presence of fields not described in `spec/openapi.yaml`.
  Clients must ignore unknown fields rather than fail on them.
- **Error message wording.** Status codes and documented error shapes are contract; prose is not.
- **Anything under `/internal/`**, the loopback-only receive-path hooks, or the inbound GitHub
  webhook receiver, whose payload contract is GitHub's.
- **The GitHub-compat plane's fidelity to GitHub.** `/api/v3` tracks what `gh` needs; where GitHub
  changes its own API, ADP follows without that counting as a major bump here.

## For consumers

Generate your client from `spec/openapi.yaml` rather than hand-writing it, and assert
`ADP-API-Version` at startup. Treat a missing header as a mismatch, not as a pass — an ADP old
enough to omit it predates this contract, which is precisely the case worth failing on.

Pre-1.0, minor versions may carry breaking changes if a design flaw is found; those will be called
out explicitly rather than shipped quietly. Pinning the ADP container by image digest alongside the
version assertion is reasonable belt-and-braces until 1.0.
