import { describe, it, expect, vi } from "vitest";
import { loadConfig } from "./config.js";

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

  it("exits fast on a missing required var rather than starting half-configured", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    loadConfig({});
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
