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
export const API_VERSION = "0.3.0";

export const API_VERSION_HEADER = "ADP-API-Version";
