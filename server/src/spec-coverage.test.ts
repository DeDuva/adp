import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { parse as parseYaml } from "yaml";
import { registerApiRoutes } from "./routes.js";
import { GitBackend } from "./core/git-backend.js";
import { Signer } from "./core/signing.js";
import type { Db } from "./db/client.js";

// `spec/` is the product ("The standard is the product",
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

function collectRoutes(): { method: string; url: string; requiredScope?: string }[] {
  const app = Fastify({ logger: false });
  const routes: { method: string; url: string; requiredScope?: string }[] = [];
  app.addHook("onRoute", (route) => {
    // #97: requireScope's returned handler carries the scope it enforces
    // (auth/plugin.ts) precisely so this test can compare it to the spec's
    // x-required-scope — the contract's authorization story is asserted
    // against the code, not maintained beside it.
    const handlers = Array.isArray(route.preHandler) ? route.preHandler : route.preHandler ? [route.preHandler] : [];
    const scoped = handlers.find((h) => typeof h === "function" && "requiredScope" in h) as
      | { requiredScope: string }
      | undefined;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      routes.push({ method, url: route.url, requiredScope: scoped?.requiredScope });
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
    // M4-5 mounts /auth/oidc/* only when an IdP is configured. Enumerating it
    // here with a dummy config is deliberate: a route that exists on
    // configured instances is part of the published contract, and leaving it
    // out would mean the spec could never describe it — the reverse check
    // below fails a documented path the server does not serve.
    oidc: {
      issuer: "https://accounts.google.com",
      discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
      clientId: "spec-coverage-test",
      clientSecret: "spec-coverage-test",
      allowedDomains: [],
      tokenTtlMinutes: 720,
      publicUrl: "https://adp.example.com",
      cookieKey: Buffer.alloc(32),
    },
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

// ── Scopes: the spec's authorization story matches the code's (#97) ───────
//
// Before 0.3.0 scopes lived only in prose: 8 authenticated GETs were marked
// anonymous and no operation declared which scope it demands. Every scoped
// route now carries `x-required-scope`, and this fails in both directions —
// a route that gained/changed a scope without the spec following, and a
// spec claim no route backs.
describe("x-required-scope matches requireScope, both directions", () => {
  const routes = collectRoutes();
  // Operations whose authorization is real but not expressed as a
  // requireScope preHandler, each with the mechanism that covers it.
  const INLINE_AUTH: Record<string, string> = {
    // http-gql/route.ts gates on hasScope(identity, "repo:read") inline and
    // mutations re-check repo:write per-resolver.
    "POST /api/graphql": "inline hasScope in the GraphQL route",
    // requireAuth only — any authenticated identity, no scope.
    "GET /api/v3": "requireAuth (identity probe)",
    "GET /api/v3/user": "requireAuth (identity probe)",
    "GET /api/v3/rate_limit": "requireAuth (identity probe)",
  };

  it("every scoped route's operation declares that exact scope; no operation claims a scope its route lacks", () => {
    const codeSide = new Map<string, string | undefined>();
    for (const r of routes) {
      if (UNDOCUMENTED.some((u) => u.pattern.test(r.url))) continue;
      codeSide.set(`${r.method.toUpperCase()} ${toSpecPath(r.url)}`, r.requiredScope);
    }

    const mismatches: string[] = [];
    for (const [path, entry] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(entry)) {
        if (typeof op !== "object" || op === null) continue;
        const id = `${method.toUpperCase()} ${path}`;
        if (!codeSide.has(id)) continue; // process-level endpoints, covered elsewhere
        const declared = (op as { "x-required-scope"?: string })["x-required-scope"];
        const enforced = codeSide.get(id);
        if (declared === enforced) continue;
        if (!enforced && id in INLINE_AUTH) continue;
        mismatches.push(`${id}: spec says ${declared ?? "(none)"}, code enforces ${enforced ?? "(none)"}`);
      }
    }
    expect(mismatches, `scope drift between spec and code:\n  ${mismatches.join("\n  ")}`).toEqual([]);
  });
});

// ── The operation set is bound to the version (#97 C-1) ───────────────────
//
// Eleven M4 operations shipped under an unmoved 0.2.0 because nothing bound
// "what the spec offers" to "what the spec claims to be" — and the version
// test passed vacuously the whole time. The checked-in snapshot
// (spec/operations.snapshot.json, regenerated via `npm run spec:snapshot`)
// records the operation set as of the current version; changing the set
// without moving `info.version` is the exact failure this catches.
describe("the operation set moves the version with it", () => {
  const METHODS = ["get", "put", "post", "delete", "patch"];
  const currentOps = Object.entries(spec.paths)
    .flatMap(([path, entry]) => METHODS.filter((m) => m in entry).map((m) => `${m.toUpperCase()} ${path}`))
    .sort();
  const snapshot = JSON.parse(
    readFileSync(new URL("../../spec/operations.snapshot.json", import.meta.url), "utf8"),
  ) as { version: string; operations: string[] };
  const specVersion = (spec as unknown as { info: { version: string } }).info.version;

  it("fails when operations change without info.version moving", () => {
    const added = currentOps.filter((o) => !snapshot.operations.includes(o));
    const removed = snapshot.operations.filter((o) => !currentOps.includes(o));
    if (added.length === 0 && removed.length === 0) return;

    expect(
      specVersion,
      "the operation set changed but info.version did not — a consumer's generated client is now stale " +
        "under a version that claims otherwise. Bump API_VERSION + spec info.version, then `npm run spec:snapshot`.\n" +
        `  added:\n    ${added.join("\n    ")}\n  removed:\n    ${removed.join("\n    ")}`,
    ).not.toBe(snapshot.version);

    // The version DID move — the snapshot just wasn't regenerated with it.
    expect.fail(
      `info.version moved (${snapshot.version} -> ${specVersion}) but the snapshot is stale — run \`npm run spec:snapshot\` and commit it with the change.`,
    );
  });

  it("keeps the snapshot's version current so the guard above compares against the right baseline", () => {
    expect(
      snapshot.version,
      "spec/operations.snapshot.json records a different version than the spec serves — run `npm run spec:snapshot`",
    ).toBe(specVersion);
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
  "GET /api/adp/repos/{owner}/{repo}/runs/{runId}",
  "GET /api/adp/repos/{owner}/{repo}/runs/{runId}/stats",
  "GET /api/adp/repos/{owner}/{repo}/runs/{runId}/trajectory",
  "GET /api/adp/repos/{owner}/{repo}/sessions/{id}",
  "GET /api/adp/repos/{owner}/{repo}/sessions/{id}/checkpoints",
  "GET /api/adp/repos/{owner}/{repo}/workspaces",
  "POST /api/adp/repos/{owner}/{repo}/candidate-sets",
  "POST /api/adp/repos/{owner}/{repo}/candidate-sets/{id}/resolve",
  "POST /api/adp/repos/{owner}/{repo}/candidate-sets/{id}/select",
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
        // SUCCESS responses only: since 0.3.0 every operation's 4xx carries
        // the shared Error schema, so "some response has content" would be
        // vacuously true everywhere — the debt this ratchet tracks is the
        // untyped 2xx a client actually consumes.
        hasSchema: Object.entries(responses).some(
          ([code, r]) => code.startsWith("2") && r && typeof r === "object" && "content" in r,
        ),
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
