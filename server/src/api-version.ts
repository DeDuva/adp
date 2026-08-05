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
export const API_VERSION = "0.1.0";

export const API_VERSION_HEADER = "ADP-API-Version";
