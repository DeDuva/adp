import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { parse as parseYaml } from "yaml";
import { API_VERSION, API_VERSION_HEADER } from "./api-version.js";
import { registerApiRoutes } from "./routes.js";
import { GitBackend } from "./core/git-backend.js";
import { Signer } from "./core/signing.js";
import type { Db } from "./db/client.js";

// The version is the whole basis on which an external, polyglot consumer can
// pin this API — see docs/api-compatibility.md. Two ways for that to rot, so
// two guards: the code and the spec disagreeing, and the server not actually
// serving what either one says.

const spec = parseYaml(readFileSync(new URL("../../spec/openapi.yaml", import.meta.url), "utf8")) as {
  info: { version: string };
};

function buildApp() {
  const app = Fastify({ logger: false });
  // Same fakes as spec-coverage.test.ts: registration touches neither the
  // database nor the filesystem.
  registerApiRoutes(app, {
    db: {} as Db,
    gitBackend: new GitBackend("/nonexistent"),
    signer: new Signer("api-version-test"),
    publicUrl: "https://adp.example.com",
    credentialKey: "api-version-test",
    instanceFloor: [],
  });
  return app;
}

describe("API version", () => {
  it("matches spec/openapi.yaml", () => {
    expect(spec.info.version).toBe(API_VERSION);
  });

  it("is a real semver, not a placeholder", () => {
    // `0.0.0-mvp` was the previous value: it never moved and nothing served it,
    // which left a consumer with nothing to assert against.
    expect(API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(API_VERSION).not.toBe("0.0.0");
  });

  it("is served on an authenticated route's rejection", async () => {
    // The case that matters: a client pins before it holds a token, so the
    // header has to survive the 401.
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/adp/repos/o/r/runs" });
    expect(res.statusCode).toBe(401);
    expect(res.headers[API_VERSION_HEADER.toLowerCase()]).toBe(API_VERSION);
    await app.close();
  });

  it("is served on an unrouted path", async () => {
    // A client pointed at something that is not ADP at all should be able to
    // tell from the absence of this header, which means its presence must not
    // depend on hitting a real route.
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/definitely-not-a-route" });
    expect(res.statusCode).toBe(404);
    expect(res.headers[API_VERSION_HEADER.toLowerCase()]).toBe(API_VERSION);
    await app.close();
  });

  it("is served on the compat plane too", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/v3/rate_limit" });
    expect(res.headers[API_VERSION_HEADER.toLowerCase()]).toBe(API_VERSION);
    await app.close();
  });
});
