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
