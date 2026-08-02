import { describe, it, expect, vi, afterEach } from "vitest";
import { loadConfig } from "./config.js";

const validEnv = {
  DATABASE_URL: "postgres://adp:adp@localhost:5432/adp",
  GIT_ROOT: "/data/git",
  SIGNING_KEY: "test-key",
  PUBLIC_URL: "https://adp.example.com",
  MIRROR_CREDENTIAL_KEY: "test-mirror-key",
};

describe("loadConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a fully specified environment and defaults PORT", () => {
    const config = loadConfig(validEnv as NodeJS.ProcessEnv);
    expect(config.PORT).toBe(3000);
    expect(config.PUBLIC_URL).toBe(validEnv.PUBLIC_URL);
  });

  it("coerces a numeric PORT string", () => {
    const config = loadConfig({ ...validEnv, PORT: "4000" } as NodeJS.ProcessEnv);
    expect(config.PORT).toBe(4000);
  });

  it("fails fast when a required var is missing", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit called");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { DATABASE_URL, ...withoutDatabaseUrl } = validEnv;
    expect(() => loadConfig(withoutDatabaseUrl as NodeJS.ProcessEnv)).toThrow("exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("fails fast on a non-URL PUBLIC_URL", () => {
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit called");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => loadConfig({ ...validEnv, PUBLIC_URL: "not-a-url" } as NodeJS.ProcessEnv)).toThrow(
      "exit called",
    );
  });
});
