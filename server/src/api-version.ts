// The version of the HTTP contract this server serves.
//
// ADP's whole proposition is that the protocol, not this codebase, is the
// commitment — external consumers are expected to be polyglot, and this
// implementation may be rewritten in another language. A consumer that
// generates its client from spec/openapi.yaml therefore needs something to
// assert against at startup, or it discovers a contract break mid-run against
// whatever instance it happened to be pointed at.
//
// `0.0.0-mvp` was not that: it is a placeholder, it never moved, and nothing
// served it. This is a real version, served on every response, and
// api-version.test.ts fails if it and spec/openapi.yaml disagree.
//
// Bump the minor for additive changes, the major for anything a generated
// client would have to be regenerated to survive.
// 0.2.0 — additive: runs carry `labels`, and a compare row carries every named
// eval alongside the single latest one it already had. Nothing a generated
// client holds today stops parsing.
// 0.3.0 — the coordinated breaking batch (#97, audit §"0.3.0 breaking
// batch"), taken while the only tokens in existence are hand-minted so
// downstream consumers regenerate exactly once. Everything M4 shipped
// additively under a wrongly-unmoved 0.2.0 (11 operations), plus: a shared
// Error schema replacing raw Zod issue objects on the wire; auth and
// per-operation scopes declared in the spec and enforced against the code
// by spec-coverage; every list endpoint bounded (limit + keyset cursor);
// the gate-jobs listing no longer inlines `logs`; org quota / policy-repo
// changes get audited REST write paths; org-level operations carry their
// org for the audit export. URLs keep `{owner}/{repo}` — gh fidelity
// requires owner-shaped URLs, so the owner string is the org's immutable
// URL slug and org rename stays unsupported pre-1.0.
// 0.4.0 — additive: M4-5 adds GET /auth/oidc/start and GET /auth/oidc/callback,
// the OpenID Connect authorization-code login. Additive in the strict sense —
// no existing operation changes shape, and both routes are absent entirely on
// an instance with no IdP configured, so a client generated against 0.3.0
// keeps working untouched. They are in the spec regardless of whether a given
// instance mounts them, because the contract describes the protocol, not one
// deployment's configuration.
// 0.5.0 — additive: M4-3 completes the org quota set with a byte ceiling.
// `max_storage_bytes` joins the PATCH body (optional, `null` clears it) and
// `quotas` on the org detail — the latter as `OrgStorageQuota`, a wider shape
// than the three counting quotas because a measured `used` can be null (never
// metered) and carries the `measured_at` that says how stale it is. Additive:
// no existing field changes shape or meaning, and a client generated against
// 0.4.0 keeps working. What DOES change for an operator is behavior, not
// contract: once a ceiling is set, four write paths can refuse with 403 that
// previously could not — trajectory append, checkpoint create, git push — and
// gate-job completion drops its logs rather than refusing, so that a storage
// quota can never become a land outage.
// 0.6.0 — additive: #152 adds GET
// /api/adp/repos/{owner}/{repo}/sessions/{id}/verify, verification scoped to
// one session and bounded to a window. The run-level endpoint could not cover
// either case it exists for: a session need not belong to a run, and a session
// long enough to be worth bounding is one worth verifying in pieces. Additive
// in the strict sense — no existing operation changes shape, so a client
// generated against 0.5.0 keeps working untouched. The same release carries
// #152's additive response fields on the run verify result (`coverage`, and per
// session `prefix`, `verified_from_seq`, `verified_to_seq`,
// `attested_heads_checked`, `anchor`) and its optional `from` query parameter,
// none of which move an existing field.
// 0.7.0 — additive, and the contract half of Phase 5 (companion mode). A
// repository whose pull requests live on GitHub gets an ADP proposal for each
// of them — a *shadow* proposal, an ordinary `proposals` row so that policy
// evaluation, the check runs and undo all keep taking the object they already
// take. On the wire that is two new nullable fields on the proposal
// representation, `upstream_number` and `upstream_url`, present and non-null
// only on an ingested one. Additive in the strict sense: no existing field
// changes shape or meaning, and a client generated against 0.6.0 keeps working
// untouched. What changes for an *operator* is behaviour rather than contract —
// a repository with inbound pull-request ingest enabled refuses natively
// created proposals, because the shadow row adopts the upstream number and
// `proposals` is unique on (repo_id, number).
//
// The same release carries #226's intent identity: an intent ingested from a
// GitHub issue records which issue, on whose host, and the evidence bundle's
// `change.intent` grows an `upstream_url` beside the `issue_number` #157 put
// there. Null on a natively filed intent. A repository with inbound ingest
// enabled likewise refuses natively filed issues, for the same numbering
// reason as proposals.
//
// #227 and #230 add no wire surface: an ingested review is an ordinary
// `reviews` row and an ingested author is an ordinary `identities` row, both
// already served by the operations they belong to. What changes is behaviour,
// and one piece of it reaches a native repository too — `one_approval` now
// counts each reviewer's most recent verdict rather than every verdict they
// have ever held, and excludes a dismissed one. A proposal whose reviewer
// approved and then asked for changes stops satisfying it, which is what
// GitHub has always done and what #121's reasoning requires.
export const API_VERSION = "0.7.0";

export const API_VERSION_HEADER = "ADP-API-Version";
