import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSarif } from "../lib/sarif.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (name) => readFile(path.join(FIXTURES, name), "utf8");

describe("parseSarif", () => {
  it("real osv-scanner SARIF output (a live scan of a lockfile with known CVEs) fails at the default level", async () => {
    // Captured from a real `osv-scanner scan -L package-lock.json --format
    // sarif` run against lodash@4.17.15 — osv-scanner marks every genuine
    // vulnerability as level "warning", never "error". This fixture is why
    // the default fail level is "warning", not "error".
    const text = await read("osv-scanner-real.sarif");
    const result = parseSarif(text);
    expect(result.status).toBe("failure");
    expect(result.counts).toEqual({ error: 0, warning: 6, note: 0, none: 0 });
  });

  it("the same real fixture passes if the caller explicitly asks for error-only", async () => {
    const text = await read("osv-scanner-real.sarif");
    const result = parseSarif(text, { failLevel: "error" });
    expect(result.status).toBe("success");
  });

  it("an error-level result fails regardless of fail level", async () => {
    const text = await read("sarif-error.sarif");
    expect(parseSarif(text).status).toBe("failure");
    expect(parseSarif(text, { failLevel: "error" }).status).toBe("failure");
  });

  it("a note-only result only fails when fail level is lowered to note", async () => {
    const text = JSON.stringify({
      runs: [{ tool: { driver: { name: "x" } }, results: [{ level: "note", message: { text: "fyi" } }] }],
    });
    expect(parseSarif(text).status).toBe("success");
    expect(parseSarif(text, { failLevel: "note" }).status).toBe("failure");
  });

  it("a clean run (no results) succeeds and says so", async () => {
    const text = await read("sarif-clean.sarif");
    const result = parseSarif(text);
    expect(result.status).toBe("success");
    expect(result.summary).toMatch(/no findings/);
  });

  it("resolves a result's level from the rule's defaultConfiguration when the result omits it", async () => {
    const text = await read("sarif-rule-default-level.sarif");
    const result = parseSarif(text);
    expect(result.status).toBe("failure");
    expect(result.counts.error).toBe(1);
  });

  it("a result with no level and no matching rule default falls back to warning", () => {
    const text = JSON.stringify({
      runs: [{ tool: { driver: { name: "x" } }, results: [{ message: { text: "?" } }] }],
    });
    const result = parseSarif(text);
    expect(result.counts.warning).toBe(1);
    expect(result.status).toBe("failure"); // warning is the default fail threshold
  });
});
