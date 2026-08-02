import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseOsvJson } from "../lib/osv-json.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (name) => readFile(path.join(FIXTURES, name), "utf8");

describe("parseOsvJson", () => {
  it("real osv-scanner JSON output (a live scan of lodash@4.17.15) reports failure with real vulnerability data", async () => {
    // Captured from a real `osv-scanner scan -L package-lock.json --format
    // json` run — not a synthetic fixture matching this parser's own
    // assumptions.
    const text = await read("osv-scanner-real.json");
    const result = parseOsvJson(text);
    expect(result.status).toBe("failure");
    expect(result.vulnerablePackageCount).toBe(1);
    expect(result.vulnerabilityCount).toBe(6);
    expect(result.summary).toContain("lodash@4.17.15");
  });

  it("real osv-scanner JSON output for a clean scan (results: []) reports success", async () => {
    const text = await read("osv-scanner-clean-real.json");
    const result = parseOsvJson(text);
    expect(result.status).toBe("success");
    expect(result.vulnerablePackageCount).toBe(0);
    expect(result.summary).toMatch(/no known vulnerabilities/);
  });

  it("dedups vulnerability ids shared across packages via aliases", () => {
    const text = JSON.stringify({
      results: [
        {
          packages: [
            { package: { name: "a", version: "1.0.0", ecosystem: "npm" }, vulnerabilities: [{ id: "GHSA-1" }] },
            {
              package: { name: "b", version: "2.0.0", ecosystem: "npm" },
              vulnerabilities: [{ id: "GHSA-1" }, { id: "GHSA-2" }],
            },
          ],
        },
      ],
    });
    const result = parseOsvJson(text);
    expect(result.vulnerablePackageCount).toBe(2);
    expect(result.vulnerabilityCount).toBe(2); // GHSA-1 counted once
  });

  it("caps the package list in the summary at 5, noting truncation", () => {
    const packages = Array.from({ length: 7 }, (_, i) => ({
      package: { name: `pkg${i}`, version: "1.0.0", ecosystem: "npm" },
      vulnerabilities: [{ id: `VULN-${i}` }],
    }));
    const text = JSON.stringify({ results: [{ packages }] });
    const result = parseOsvJson(text);
    expect(result.summary).toContain("...");
    expect(result.vulnerablePackageCount).toBe(7);
  });

  it("an empty results array is success", () => {
    expect(parseOsvJson(JSON.stringify({ results: [] })).status).toBe("success");
  });
});
