import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { parse as parseYaml } from "yaml";
import { registerApiRoutes } from "./routes.js";
import { GitBackend } from "./core/git-backend.js";
import { Signer } from "./core/signing.js";
import type { Db } from "./db/client.js";

// `spec/` is the product (docs/pragmatic_mvp.md: "The standard is the product",
// "spec and server are public from the first commit"). A spec that has drifted
// behind the implementation quietly undermines the one claim ADP cannot buy
// back — that the protocol, not the codebase, is the commitment.
//
// It *had* drifted: `spec/openapi.yaml` was written at M0/M1a and never
// followed the server. This test is the guard that keeps it from happening
// again, and it works by enumerating the *real* route table (src/routes.ts,
// the same one main.ts registers) rather than a hand-maintained list that could
// drift in exactly the way it is meant to detect.

// Routes that are deliberately not in the public API spec, each with the reason
// it is excluded. An exclusion list with reasons is reviewable; a regex that
// quietly swallows paths is not.
const UNDOCUMENTED: { pattern: RegExp; why: string }[] = [
  {
    pattern: /^\/internal\/hooks\//,
    why: "loopback-only, called by the git hook scripts this server writes into each bare repo — not a client-facing API",
  },
  {
    pattern: /^\/webhooks\/github\//,
    why: "inbound receiver for GitHub's own webhook shape; the payload contract is GitHub's, not ADP's",
  },
  {
    pattern: /\.git(\/|$)/,
    why: "git smart-HTTP wire protocol, specified by git itself and proxied verbatim to git-http-backend",
  },
  {
    pattern: /^\/:owner\/:repo\//,
    why: "git smart-HTTP wire protocol (info/refs, upload-pack, receive-pack)",
  },
];

function collectRoutes(): { method: string; url: string }[] {
  const app = Fastify({ logger: false });
  const routes: { method: string; url: string }[] = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      routes.push({ method, url: route.url });
    }
  });

  // Registration touches neither the database nor the filesystem — the handlers
  // do, and none of them run here.
  registerApiRoutes(app, {
    db: {} as Db,
    gitBackend: new GitBackend("/nonexistent"),
    signer: new Signer("spec-coverage-test"),
    publicUrl: "https://adp.example.com",
    credentialKey: "spec-coverage-test",
    instanceFloor: [],
  });

  return routes;
}

// Fastify writes `:owner`; OpenAPI writes `{owner}`. Wildcards (`/*`) are
// documented as a trailing `{path}` parameter.
function toSpecPath(fastifyUrl: string): string {
  return fastifyUrl.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\/\*$/, "/{path}");
}

const spec = parseYaml(readFileSync(new URL("../../spec/openapi.yaml", import.meta.url), "utf8")) as {
  paths: Record<string, Record<string, unknown>>;
};

describe("spec/openapi.yaml describes the API this server actually serves", () => {
  const routes = collectRoutes();
  const documented = new Set(Object.keys(spec.paths));

  it("registers a non-trivial route table (guards against the check passing vacuously)", () => {
    // If registerApiRoutes ever silently stopped registering, every assertion
    // below would pass over an empty set. This is the tripwire for that.
    expect(routes.length).toBeGreaterThan(40);
  });

  it("documents every route the server serves", () => {
    const missing = routes
      .filter((r) => !UNDOCUMENTED.some((u) => u.pattern.test(r.url)))
      .map((r) => `${r.method} ${toSpecPath(r.url)}`)
      .filter((entry) => !documented.has(entry.split(" ")[1]!))
      .sort();

    expect(missing, `undocumented routes — add them to spec/openapi.yaml:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("documents each route's methods, not just its path", () => {
    const served = new Map<string, Set<string>>();
    for (const route of routes) {
      if (UNDOCUMENTED.some((u) => u.pattern.test(route.url))) continue;
      const specPath = toSpecPath(route.url);
      if (!served.has(specPath)) served.set(specPath, new Set());
      served.get(specPath)!.add(route.method.toLowerCase());
    }

    const mismatches: string[] = [];
    for (const [specPath, methods] of served) {
      const entry = spec.paths[specPath];
      if (!entry) continue; // covered by the previous test
      for (const method of methods) {
        if (!(method in entry)) mismatches.push(`${method.toUpperCase()} ${specPath}`);
      }
    }

    expect(mismatches, `served but undocumented methods:\n  ${mismatches.join("\n  ")}`).toEqual([]);
  });

  it("does not document routes the server no longer serves", () => {
    const servedPaths = new Set(
      routes.filter((r) => !UNDOCUMENTED.some((u) => u.pattern.test(r.url))).map((r) => toSpecPath(r.url)),
    );
    // Process-level endpoints main.ts registers directly rather than through
    // the route table: liveness, readiness, and the metrics scrape.
    for (const p of ["/healthz", "/readyz", "/metrics", "/version"]) servedPaths.add(p);

    const phantom = [...documented].filter((p) => !servedPaths.has(p)).sort();
    expect(phantom, `documented but not served — stale spec entries:\n  ${phantom.join("\n  ")}`).toEqual([]);
  });
});

// ── Response schemas on the native plane ──────────────────────────────────
//
// Requests were typed by the spec and responses were not, so a generated client
// could only ever type half the contract — and the untyped half is where a
// consumer's bugs live. adp-replay, the first external client, was written from
// the prose and got two of five fields of the append result wrong. See issue #64.
//
// This list is the debt that existed when the guard went in. It may shrink and
// must never grow: an entry here is an operation whose response a client has to
// guess at. Delete a line when you attach a schema; adding one needs a reason
// better than "the test failed".
const RESPONSE_SCHEMA_DEBT = new Set<string>([
  "DELETE /api/adp/repos/{owner}/{repo}/workspaces/{id}",
  "GET /api/adp/repos/{owner}/{repo}/candidate-sets",
  "GET /api/adp/repos/{owner}/{repo}/candidate-sets/{id}",
  "GET /api/adp/repos/{owner}/{repo}/evidence/{sha}",
  "GET /api/adp/repos/{owner}/{repo}/operations",
  "GET /api/adp/repos/{owner}/{repo}/operations/{id}",
  "GET /api/adp/repos/{owner}/{repo}/runs",
  "GET /api/adp/repos/{owner}/{repo}/runs/compare",
  "GET /api/adp/repos/{owner}/{repo}/runs/{runId}",
  "GET /api/adp/repos/{owner}/{repo}/runs/{runId}/evals",
  "GET /api/adp/repos/{owner}/{repo}/runs/{runId}/stats",
  "GET /api/adp/repos/{owner}/{repo}/runs/{runId}/trajectory",
  "GET /api/adp/repos/{owner}/{repo}/runs/{runId}/verify",
  "GET /api/adp/repos/{owner}/{repo}/sessions/{id}",
  "GET /api/adp/repos/{owner}/{repo}/sessions/{id}/checkpoints",
  "GET /api/adp/repos/{owner}/{repo}/workspaces",
  "POST /api/adp/repos/{owner}/{repo}/candidate-sets",
  "POST /api/adp/repos/{owner}/{repo}/candidate-sets/{id}/resolve",
  "POST /api/adp/repos/{owner}/{repo}/candidate-sets/{id}/select",
  "POST /api/adp/repos/{owner}/{repo}/operations/{id}/undo",
  "POST /api/adp/repos/{owner}/{repo}/runs",
  "POST /api/adp/repos/{owner}/{repo}/runs/{runId}/abandon",
  "POST /api/adp/repos/{owner}/{repo}/runs/{runId}/close",
  "POST /api/adp/repos/{owner}/{repo}/runs/{runId}/evals",
  "POST /api/adp/repos/{owner}/{repo}/sessions",
  "POST /api/adp/repos/{owner}/{repo}/sessions/{id}/checkpoints",
  "POST /api/adp/repos/{owner}/{repo}/sessions/{id}/close",
  "POST /api/adp/repos/{owner}/{repo}/sessions/{id}/resume",
  "POST /api/adp/repos/{owner}/{repo}/workspaces",
]);

describe("native-plane responses are typed, not merely described", () => {
  const operations: { id: string; hasSchema: boolean }[] = [];
  for (const [path, entry] of Object.entries(spec.paths)) {
    if (!path.startsWith("/api/adp")) continue;
    for (const [method, op] of Object.entries(entry)) {
      if (typeof op !== "object" || op === null) continue;
      const responses = (op as { responses?: Record<string, { content?: unknown }> }).responses;
      if (!responses) continue;
      operations.push({
        id: `${method.toUpperCase()} ${path}`,
        hasSchema: Object.values(responses).some((r) => r && typeof r === "object" && "content" in r),
      });
    }
  }

  it("enumerates native-plane operations (guards against passing vacuously)", () => {
    expect(operations.length).toBeGreaterThan(25);
  });

  it("every operation either carries a response schema or is a known, listed gap", () => {
    const undeclared = operations
      .filter((o) => !o.hasSchema && !RESPONSE_SCHEMA_DEBT.has(o.id))
      .map((o) => o.id)
      .sort();

    expect(
      undeclared,
      "native-plane operations with no response schema and no entry in RESPONSE_SCHEMA_DEBT.\n" +
        "Attach a schema under components/schemas — do not add these to the debt list:\n  " +
        undeclared.join("\n  "),
    ).toEqual([]);
  });

  it("the debt list has no stale entries", () => {
    // A schema was attached but the line was left behind. Harmless to the
    // contract and corrosive to the list: a debt register nobody trusts stops
    // being read, and this one is the only thing keeping the gap from growing.
    const ids = new Set(operations.map((o) => o.id));
    const stale = [...RESPONSE_SCHEMA_DEBT]
      .filter((entry) => !ids.has(entry) || operations.find((o) => o.id === entry)?.hasSchema)
      .sort();

    expect(stale, `remove from RESPONSE_SCHEMA_DEBT — these now have schemas:\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});
