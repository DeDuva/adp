import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveConfig, loadConfig } from "../src/config.js";

describe("config", () => {
  let configDir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "adp-cli-config-"));
    process.env.ADP_CONFIG_DIR = configDir;
    delete process.env.ADP_SERVER_URL;
    delete process.env.ADP_TOKEN;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(configDir, { recursive: true, force: true });
  });

  it("round-trips a saved config, written with owner-only permissions", async () => {
    await saveConfig({ serverUrl: "http://localhost:3000", token: "s3cr3t" });
    const loaded = await loadConfig();
    expect(loaded).toEqual({ serverUrl: "http://localhost:3000", token: "s3cr3t" });

    const stats = await stat(path.join(configDir, "config.json"));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("prefers ADP_SERVER_URL/ADP_TOKEN over a saved config file", async () => {
    await saveConfig({ serverUrl: "http://saved", token: "saved-token" });
    process.env.ADP_SERVER_URL = "http://env-override";
    process.env.ADP_TOKEN = "env-token";
    expect(await loadConfig()).toEqual({ serverUrl: "http://env-override", token: "env-token" });
  });

  it("throws a helpful error when never logged in", async () => {
    await expect(loadConfig()).rejects.toThrow(/not logged in/i);
  });

  it("saved file is valid JSON matching the AdpConfig shape", async () => {
    await saveConfig({ serverUrl: "http://x", token: "y" });
    const raw = await readFile(path.join(configDir, "config.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({ serverUrl: "http://x", token: "y" });
  });
});
