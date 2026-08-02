import { describe, it, expect, vi } from "vitest";
import { evaluateDependency, evaluateDependencies } from "./dependency-admission.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// A fake fetch keyed on URL substring — OSV always POSTs to api.osv.dev,
// npm registry lookups always GET registry.npmjs.org/<name>, so routing on
// substring keeps these tests independent of call order/count.
function fakeFetch(routes: { match: string; response: Response | (() => Response) }[]): typeof fetch {
  return (async (url: string | URL) => {
    const target = String(url);
    for (const route of routes) {
      if (target.includes(route.match)) {
        return typeof route.response === "function" ? route.response() : route.response;
      }
    }
    throw new Error(`fakeFetch: no route matched ${target}`);
  }) as typeof fetch;
}

describe("evaluateDependency (mocked network)", () => {
  it("blocks a package OSV reports as malicious (MAL- id), regardless of registry state", async () => {
    const fetchImpl = fakeFetch([
      { match: "api.osv.dev", response: jsonResponse(200, { vulns: [{ id: "MAL-2025-2155" }] }) },
      // Never actually called for a blocked package, but present to prove
      // the block decision doesn't depend on it.
      { match: "registry.npmjs.org", response: jsonResponse(200, { time: {} }) },
    ]);
    const verdict = await evaluateDependency({ ecosystem: "npm", name: "sdxcode1", version: "9.9.9" }, { fetchImpl });
    expect(verdict.verdict).toBe("block");
    expect(verdict.reasons[0]).toContain("MAL-2025-2155");
  });

  it("quarantines a package with known (non-malicious) vulnerabilities", async () => {
    const fetchImpl = fakeFetch([
      { match: "api.osv.dev", response: jsonResponse(200, { vulns: [{ id: "GHSA-xxxx" }] }) },
      {
        match: "registry.npmjs.org",
        response: jsonResponse(200, { time: { "4.17.15": new Date(Date.now() - 365 * 86400_000).toISOString() } }),
      },
    ]);
    const verdict = await evaluateDependency({ ecosystem: "npm", name: "lodash", version: "4.17.15" }, { fetchImpl });
    expect(verdict.verdict).toBe("quarantine");
    expect(verdict.reasons.join(" ")).toContain("GHSA-xxxx");
  });

  it("quarantines a package that doesn't exist in the npm registry", async () => {
    const fetchImpl = fakeFetch([
      { match: "api.osv.dev", response: jsonResponse(200, {}) },
      { match: "registry.npmjs.org", response: jsonResponse(404, {}) },
    ]);
    const verdict = await evaluateDependency({ ecosystem: "npm", name: "does-not-exist", version: "1.0.0" }, { fetchImpl });
    expect(verdict.verdict).toBe("quarantine");
    expect(verdict.reasons[0]).toMatch(/not found in the npm registry/);
  });

  it("quarantines a version that exists on the package but isn't in registry .time (can't verify)", async () => {
    const fetchImpl = fakeFetch([
      { match: "api.osv.dev", response: jsonResponse(200, {}) },
      { match: "registry.npmjs.org", response: jsonResponse(200, { time: { "1.0.0": "2020-01-01T00:00:00Z" } }) },
    ]);
    const verdict = await evaluateDependency({ ecosystem: "npm", name: "pkg", version: "9.9.9" }, { fetchImpl });
    expect(verdict.verdict).toBe("quarantine");
  });

  it("quarantines a freshly-published version within the cooldown window", async () => {
    const fetchImpl = fakeFetch([
      { match: "api.osv.dev", response: jsonResponse(200, {}) },
      { match: "registry.npmjs.org", response: jsonResponse(200, { time: { "1.0.0": new Date().toISOString() } }) },
    ]);
    const verdict = await evaluateDependency(
      { ecosystem: "npm", name: "brand-new", version: "1.0.0" },
      { fetchImpl, cooldownDays: 3 },
    );
    expect(verdict.verdict).toBe("quarantine");
    expect(verdict.reasons[0]).toMatch(/cooldown window/);
  });

  it("admits a package published well before the cooldown window with no OSV findings", async () => {
    const fetchImpl = fakeFetch([
      { match: "api.osv.dev", response: jsonResponse(200, {}) },
      {
        match: "registry.npmjs.org",
        response: jsonResponse(200, { time: { "1.0.0": new Date(Date.now() - 365 * 86400_000).toISOString() } }),
      },
    ]);
    const verdict = await evaluateDependency({ ecosystem: "npm", name: "is-odd", version: "1.0.0" }, { fetchImpl, cooldownDays: 3 });
    expect(verdict).toEqual({
      ecosystem: "npm",
      name: "is-odd",
      version: "1.0.0",
      verdict: "admit",
      reasons: [],
    });
  });

  it("quarantines a non-npm ecosystem it cannot verify, even with no OSV findings", async () => {
    const fetchImpl = fakeFetch([{ match: "api.osv.dev", response: jsonResponse(200, {}) }]);
    const verdict = await evaluateDependency({ ecosystem: "PyPI", name: "requests", version: "2.31.0" }, { fetchImpl });
    expect(verdict.verdict).toBe("quarantine");
    expect(verdict.reasons[0]).toMatch(/not verified for ecosystem 'PyPI'/);
  });

  it("surfaces an OSV HTTP error rather than silently admitting", async () => {
    const fetchImpl = fakeFetch([{ match: "api.osv.dev", response: jsonResponse(500, {}) }]);
    await expect(evaluateDependency({ ecosystem: "npm", name: "x", version: "1.0.0" }, { fetchImpl })).rejects.toThrow(/HTTP 500/);
  });
});

describe("evaluateDependencies (mocked network)", () => {
  it("aggregates to status=failure when any package is blocked, regardless of other verdicts", async () => {
    // The malicious-vs-clean OSV response needs to vary per package name, so
    // this test drives it through a spy that inspects the request body
    // rather than the simpler match-by-URL fakeFetch helper.
    const spyFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("api.osv.dev")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.package?.name === "evil-pkg") return jsonResponse(200, { vulns: [{ id: "MAL-1" }] });
        return jsonResponse(200, {});
      }
      return jsonResponse(200, { time: { "1.0.0": new Date(Date.now() - 365 * 86400_000).toISOString() } });
    }) as unknown as typeof fetch;

    const result = await evaluateDependencies(
      [
        { ecosystem: "npm", name: "evil-pkg", version: "1.0.0" },
        { ecosystem: "npm", name: "fine-pkg", version: "1.0.0" },
      ],
      { fetchImpl: spyFetch },
    );
    expect(result.status).toBe("failure");
    expect(result.summary).toContain("blocked");
    expect(spyFetch).toHaveBeenCalled();
  });

  it("aggregates to status=pending when packages quarantine but none block", async () => {
    const fetchImpl = fakeFetch([
      { match: "api.osv.dev", response: jsonResponse(200, {}) },
      { match: "registry.npmjs.org", response: jsonResponse(404, {}) },
    ]);
    const result = await evaluateDependencies([{ ecosystem: "npm", name: "unknown-pkg", version: "1.0.0" }], { fetchImpl });
    expect(result.status).toBe("pending");
    expect(result.summary).toContain("quarantined");
  });

  it("aggregates to status=success when every package is admitted", async () => {
    const fetchImpl = fakeFetch([
      { match: "api.osv.dev", response: jsonResponse(200, {}) },
      {
        match: "registry.npmjs.org",
        response: jsonResponse(200, { time: { "1.0.0": new Date(Date.now() - 365 * 86400_000).toISOString() } }),
      },
    ]);
    const result = await evaluateDependencies([{ ecosystem: "npm", name: "fine-pkg", version: "1.0.0" }], { fetchImpl });
    expect(result.status).toBe("success");
    expect(result.summary).toContain("admitted");
  });
});

// Real network calls against the live public OSV.dev and npm registry APIs
// — no mocking. Verified once by hand already (curl, during development):
// sdxcode1@9.9.9 is a real OpenSSF-reported malicious npm package
// (MAL-2025-2155), lodash@4.17.15 has real, non-malicious CVEs, and
// is-odd@3.0.1 is real, old, and clean. Kept as a live suite (not just
// fixtures) because the entire point of this module is two real external
// APIs; GitHub Actions runners have outbound internet access same as the
// existing conformance job's gh-binary download.
describe("evaluateDependency (live network)", () => {
  it("blocks a real OpenSSF-reported malicious npm package", async () => {
    const verdict = await evaluateDependency({ ecosystem: "npm", name: "sdxcode1", version: "9.9.9" });
    expect(verdict.verdict).toBe("block");
    expect(verdict.reasons[0]).toContain("MAL-");
  }, 15_000);

  it("quarantines a real vulnerable-but-not-malicious npm package (old enough to clear cooldown)", async () => {
    const verdict = await evaluateDependency({ ecosystem: "npm", name: "lodash", version: "4.17.15" }, { cooldownDays: 3 });
    expect(verdict.verdict).toBe("quarantine");
    expect(verdict.reasons.join(" ")).toMatch(/known vulnerabilities/);
  }, 15_000);

  it("admits a real, old, clean npm package", async () => {
    const verdict = await evaluateDependency({ ecosystem: "npm", name: "is-odd", version: "3.0.1" }, { cooldownDays: 3 });
    expect(verdict).toEqual({ ecosystem: "npm", name: "is-odd", version: "3.0.1", verdict: "admit", reasons: [] });
  }, 15_000);
});
