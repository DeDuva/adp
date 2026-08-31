import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findHarness, harnessNames, removeMcpServer, writeMcpServer } from "../src/harnesses.js";

const SPEC = { command: "/usr/bin/node", args: ["/opt/adp/server.js"], env: { ADP_TOKEN: "t" } };

describe("harness configuration", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "adp-connect-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

  it("covers the three harnesses connect claims to", () => {
    expect(harnessNames()).toEqual(["claude-code", "codex", "gemini-cli"]);
  });

  it("writes everything inside the repository, never into the home directory", () => {
    // The property that makes disconnect trustworthy: nothing ADP writes can
    // be left orphaned somewhere a user will never look, and two checkouts of
    // two projects cannot fight over one file.
    for (const harness of harnessNames()) {
      const written = writeMcpServer(root, findHarness(harness)!, SPEC);
      expect(written.file.startsWith(root)).toBe(true);
    }
  });

  it("merges into a JSON config without disturbing what is already there", () => {
    writeFileSync(
      path.join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } }, somethingElse: 1 }, null, 2),
    );
    writeMcpServer(root, findHarness("claude-code")!, SPEC);
    const doc = JSON.parse(read(".mcp.json"));
    expect(doc.mcpServers.other).toEqual({ command: "x" });
    expect(doc.somethingElse).toBe(1);
    expect(doc.mcpServers.adp).toEqual(SPEC);
  });

  it("replaces its own entry rather than adding a second one", () => {
    // Idempotence by construction: re-running after a harness upgrade repairs
    // the entry, which is what #154 asks for.
    const harness = findHarness("claude-code")!;
    writeMcpServer(root, harness, SPEC);
    writeMcpServer(root, harness, { ...SPEC, command: "/usr/local/bin/node" });
    const doc = JSON.parse(read(".mcp.json"));
    expect(Object.keys(doc.mcpServers)).toEqual(["adp"]);
    expect(doc.mcpServers.adp.command).toBe("/usr/local/bin/node");
  });

  it("refuses to overwrite a JSON file it cannot parse", () => {
    // Somebody wrote that file. Replacing it with ADP's one key is a worse
    // outcome than saying so.
    writeFileSync(path.join(root, ".mcp.json"), "{ not json");
    expect(() => writeMcpServer(root, findHarness("claude-code")!, SPEC)).toThrow(/cannot parse/);
  });

  it("writes a TOML table Codex's config loader would read", () => {
    writeMcpServer(root, findHarness("codex")!, SPEC);
    const toml = read(path.join(".codex", "config.toml"));
    expect(toml).toContain("[mcp_servers.adp]");
    expect(toml).toContain('command = "/usr/bin/node"');
    expect(toml).toContain('args = ["/opt/adp/server.js"]');
    expect(toml).toContain("[mcp_servers.adp.env]");
    expect(toml).toContain('ADP_TOKEN = "t"');
  });

  it("replaces its TOML table, table and sub-table together, and keeps the rest", () => {
    const file = path.join(root, ".codex", "config.toml");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n');
    const harness = findHarness("codex")!;
    writeMcpServer(root, harness, SPEC);
    writeMcpServer(root, harness, { ...SPEC, command: "/second" });
    const toml = readFileSync(file, "utf8");
    expect(toml).toContain('model = "gpt-5"');
    expect(toml).toContain("[mcp_servers.other]");
    expect(toml.match(/\[mcp_servers\.adp\]/g)).toHaveLength(1);
    expect(toml).toContain('command = "/second"');
    expect(toml).not.toContain('command = "/usr/bin/node"');
  });

  it("deletes a file it created from nothing, and keeps one it did not", () => {
    // The difference between "leaves no orphaned config" and "leaves a tidy
    // empty one".
    const harness = findHarness("gemini-cli")!;
    writeMcpServer(root, harness, SPEC);
    expect(removeMcpServer(root, harness).removed).toBe(true);
    expect(existsSync(path.join(root, ".gemini", "settings.json"))).toBe(false);

    writeFileSync(path.join(root, ".gemini", "settings.json"), JSON.stringify({ theme: "dark" }));
    writeMcpServer(root, harness, SPEC);
    removeMcpServer(root, harness);
    const doc = JSON.parse(read(path.join(".gemini", "settings.json")));
    expect(doc).toEqual({ theme: "dark" });
  });

  it("leaves a TOML file holding somebody else's tables", () => {
    const file = path.join(root, ".codex", "config.toml");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '[mcp_servers.other]\ncommand = "x"\n');
    const harness = findHarness("codex")!;
    writeMcpServer(root, harness, SPEC);
    removeMcpServer(root, harness);
    const toml = readFileSync(file, "utf8");
    expect(toml).toContain("[mcp_servers.other]");
    expect(toml).not.toContain("mcp_servers.adp");
  });

  it("does nothing when there is nothing of ADP's to remove", () => {
    expect(removeMcpServer(root, findHarness("codex")!).removed).toBe(false);
  });
});
