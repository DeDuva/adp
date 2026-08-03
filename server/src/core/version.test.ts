import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { resolveBuildInfo, versionPayload, registerVersionRoute } from "./version.js";

describe("build info", () => {
  it("prefers the deploy-time stamp over anything the checkout says", () => {
    const build = resolveBuildInfo({
      ADP_GIT_SHA: "60be968f0a4a2a4f5f7c0f9e1d2c3b4a5968ab01",
      ADP_GIT_REF: "main",
      ADP_DEPLOYED_AT: "2026-08-03T15:04:05Z",
    } as NodeJS.ProcessEnv);

    expect(build).toEqual({
      sha: "60be968f0a4a2a4f5f7c0f9e1d2c3b4a5968ab01",
      ref: "main",
      builtAt: "2026-08-03T15:04:05Z",
    });
  });

  it("falls back to the working checkout when the deploy stamp is absent", () => {
    // The test always runs inside this repo's checkout, so the fallback has a
    // real answer here; the deployed container is the case that does not.
    const build = resolveBuildInfo({} as NodeJS.ProcessEnv);
    expect(build.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(build.ref).not.toBe("");
  });

  it("ignores a stamp that was rendered but never filled in", () => {
    // startup.sh writes the file unconditionally; an empty value there means
    // "the capture failed", not "the SHA is the empty string".
    const build = resolveBuildInfo({ ADP_GIT_SHA: "  ", ADP_DEPLOYED_AT: "" } as NodeJS.ProcessEnv);
    expect(build.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("versionPayload", () => {
  const build = { sha: "cd5e61d", ref: "main", builtAt: "2026-08-03T12:00:00.000Z" };

  it("reports uptime in whole seconds from the process start", () => {
    const startedAt = new Date("2026-08-03T12:00:00.000Z");
    const payload = versionPayload(build, startedAt, new Date("2026-08-03T12:02:03.500Z"));

    expect(payload).toEqual({
      sha: "cd5e61d",
      ref: "main",
      builtAt: "2026-08-03T12:00:00.000Z",
      startedAt: "2026-08-03T12:00:00.000Z",
      uptimeSeconds: 123,
    });
  });

  it("never reports negative uptime if the clock steps backwards", () => {
    const startedAt = new Date("2026-08-03T12:00:00.000Z");
    expect(versionPayload(build, startedAt, new Date("2026-08-03T11:59:00.000Z")).uptimeSeconds).toBe(0);
  });
});

describe("GET /version", () => {
  it("answers unauthenticated with the deployed SHA", async () => {
    const app = Fastify({ logger: false });
    const startedAt = new Date(Date.now() - 5_000);
    registerVersionRoute(app, { sha: "60be968", ref: "main", builtAt: "2026-08-03T12:00:00.000Z" }, startedAt);

    const res = await app.inject({ method: "GET", url: "/version" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sha: "60be968", ref: "main", builtAt: "2026-08-03T12:00:00.000Z" });
    expect(res.json().uptimeSeconds).toBeGreaterThanOrEqual(5);
    expect(res.headers["content-type"]).toContain("application/json");
    await app.close();
  });

  it("reports builtAt as null rather than omitting it when the deploy left no stamp", async () => {
    const app = Fastify({ logger: false });
    registerVersionRoute(app, { sha: "unknown", ref: "unknown", builtAt: null }, new Date());

    const res = await app.inject({ method: "GET", url: "/version" });

    expect(res.json()).toHaveProperty("builtAt", null);
    await app.close();
  });
});
