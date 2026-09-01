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
export const API_VERSION = "0.6.0";

export const API_VERSION_HEADER = "ADP-API-Version";
