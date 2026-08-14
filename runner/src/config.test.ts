import { describe, it, expect, vi } from "vitest";
import { loadConfig, imageAllowed } from "./config.js";

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ADP_SERVER_URL: "https://adp.example.com",
    ADP_RUNNER_TOKEN: "adp_pat_test",
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("accepts the minimal required env and fills in defaults", () => {
    const config = loadConfig(baseEnv());
    expect(config.ADP_SERVER_URL).toBe("https://adp.example.com");
    expect(config.POLL_INTERVAL_MS).toBe(2000);
    expect(config.RUNNER_MEMORY).toBe("2g");
    expect(config.RUNNER_CPUS).toBe("2");
    // Not fixed across runs — two runner processes on the same host must not
    // collide as the same claimed_by identity.
    expect(config.RUNNER_ID).toContain(`-${process.pid}`);
  });

  it("never validates or requires a database or signing-key credential — this process is not meant to hold either", () => {
    const config = loadConfig(baseEnv());
    expect(config).not.toHaveProperty("DATABASE_URL");
    expect(config).not.toHaveProperty("SIGNING_KEY");
  });

  it("respects an explicit RUNNER_ID rather than the generated default", () => {
    const config = loadConfig(baseEnv({ RUNNER_ID: "fixed-runner-1" }));
    expect(config.RUNNER_ID).toBe("fixed-runner-1");
  });

  it("parses the image allowlist: exact refs, digest pins, and prefix globs; unset allows all (#100)", () => {
    expect(imageAllowed("busybox:1", undefined)).toBe(true);
    expect(imageAllowed("busybox:1", "busybox:1, node:22")).toBe(true);
    expect(imageAllowed("node:22", "busybox:1, node:22")).toBe(true);
    expect(imageAllowed("node:20", "busybox:1, node:22")).toBe(false);
    expect(imageAllowed("ghcr.io/acme/gates:v3", "ghcr.io/acme/*")).toBe(true);
    expect(imageAllowed("ghcr.io/evil/gates:v3", "ghcr.io/acme/*")).toBe(false);
    const pinned = "node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(imageAllowed(pinned, pinned)).toBe(true);
    expect(imageAllowed("node:22", pinned)).toBe(false);
    // A configured-but-empty list is a deliberate "nothing runs here", not
    // a fall-through to allow-all.
    expect(imageAllowed("busybox:1", "")).toBe(false);
  });

  it("exits fast on a missing required var rather than starting half-configured", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    loadConfig({});
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
