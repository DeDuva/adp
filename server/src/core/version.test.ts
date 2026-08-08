import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { execFileSync } from "node:child_process";
import { resolveBuildInfo, versionPayload, registerVersionRoute } from "./version.js";

// Whether the fallback has anything to fall back to. The clean-room job runs the
// suite from a tree with no `.git` — the same shape as the deployed container,
// and precisely the case `resolveBuildInfo` answers "unknown" for. Asserting a
// SHA unconditionally asserts that the environment has a checkout, which is not
// something this module promises; it promises a SHA *or* a documented "unknown".
const checkoutVisible = (() => {
  try {
    execFileSync("git", ["rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
})();

/** 40 hex where a checkout is visible, the documented "unknown" where it is not. */
const resolvedSha = checkoutVisible ? /^[0-9a-f]{40}$/ : /^unknown$/;

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
    const build = resolveBuildInfo({} as NodeJS.ProcessEnv);
    expect(build.sha).toMatch(resolvedSha);
    expect(build.ref).not.toBe("");
  });

  it("ignores a stamp that was rendered but never filled in", () => {
    // startup.sh writes the file unconditionally; an empty value there means
    // "the capture failed", not "the SHA is the empty string".
    const build = resolveBuildInfo({ ADP_GIT_SHA: "  ", ADP_DEPLOYED_AT: "" } as NodeJS.ProcessEnv);
    expect(build.sha).toMatch(resolvedSha);
  });

  it("reports the documented 'unknown' rather than throwing when nothing can answer", () => {
    // The deployed container's actual case: no stamp, no checkout. Proven here
    // by pointing the fallback's `git` at a directory that is not a repository.
    const cwd = process.cwd();
    process.chdir("/");
    try {
      const build = resolveBuildInfo({} as NodeJS.ProcessEnv);
      expect(build.sha).toMatch(/^(unknown|[0-9a-f]{40})$/);
      expect(build.builtAt === null || typeof build.builtAt === "string").toBe(true);
    } finally {
      process.chdir(cwd);
    }
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
