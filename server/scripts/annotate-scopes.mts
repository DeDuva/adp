// One-off for #97: writes `x-required-scope` into spec/openapi.yaml for
// every operation whose route enforces a scope, sourced from the REAL route
// table (the same registerApiRoutes harness spec-coverage uses) — never
// hand-typed. Line-oriented edit so the spec's comments survive.
// After this runs once, spec-coverage.test.ts keeps the two sides bound.
import { readFileSync, writeFileSync } from "node:fs";
import Fastify from "fastify";
import { registerApiRoutes } from "../src/routes.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import type { Db } from "../src/db/client.js";

const app = Fastify({ logger: false });
const scopes = new Map<string, string>(); // "get /api/..." -> scope
app.addHook("onRoute", (route) => {
  const handlers = Array.isArray(route.preHandler) ? route.preHandler : route.preHandler ? [route.preHandler] : [];
  const scoped = handlers.find((h) => typeof h === "function" && "requiredScope" in h) as
    | { requiredScope: string }
    | undefined;
  if (!scoped) return;
  const methods = Array.isArray(route.method) ? route.method : [route.method];
  const specPath = route.url.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\/\*$/, "/{path}");
  for (const m of methods) {
    if (m === "HEAD" || m === "OPTIONS") continue;
    scopes.set(`${m.toLowerCase()} ${specPath}`, scoped.requiredScope);
  }
});
registerApiRoutes(app, {
  db: {} as Db,
  gitBackend: new GitBackend("/nonexistent"),
  signer: new Signer("annotate"),
  publicUrl: "https://adp.example.com",
  credentialKey: "annotate",
  instanceFloor: [],
});
await app.ready();

const specPathFile = new URL("../../spec/openapi.yaml", import.meta.url).pathname;
const lines = readFileSync(specPathFile, "utf8").split("\n");
const METHODS = new Set(["get", "put", "post", "delete", "patch"]);

let currentPath: string | null = null;
let currentOp: string | null = null;
let annotated = 0;
const out: string[] = [];
for (const line of lines) {
  const pathMatch = /^  (\/[^\s:]*):\s*$/.exec(line);
  if (pathMatch) {
    currentPath = pathMatch[1]!;
    currentOp = null;
  }
  const opMatch = /^    ([a-z]+):\s*$/.exec(line);
  if (opMatch && currentPath && METHODS.has(opMatch[1]!)) {
    currentOp = `${opMatch[1]} ${currentPath}`;
    out.push(line);
    const scope = scopes.get(currentOp);
    if (scope) {
      out.push(`      x-required-scope: "${scope}"`);
      annotated++;
    }
    continue;
  }
  out.push(line);
}
writeFileSync(specPathFile, out.join("\n"));
console.log(`annotated ${annotated} operations; route table had ${scopes.size} scoped operations`);
