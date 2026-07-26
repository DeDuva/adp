import { describe, it, expect } from "vitest";
import { BundledSecretScanProvider } from "./secret-scan.js";

describe("BundledSecretScanProvider", () => {
  const provider = new BundledSecretScanProvider();

  it("finds an AWS access key id on an added line", () => {
    const patch = [
      "diff --git a/config.py b/config.py",
      "--- a/config.py",
      "+++ b/config.py",
      "@@ -1,0 +1,1 @@",
      "+AWS_KEY = 'AKIAABCDEFGHIJKLMNOP'",
    ].join("\n");
    const findings = provider.scanDiff(patch);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.pattern).toBe("aws-access-key-id");
    expect(findings[0]!.line).toBe(1);
  });

  it("finds a private key block", () => {
    const patch = ["@@ -0,0 +1,1 @@", "+-----BEGIN RSA PRIVATE KEY-----"].join("\n");
    const findings = provider.scanDiff(patch);
    expect(findings.some((f) => f.pattern === "private-key-block")).toBe(true);
  });

  it("finds a github token", () => {
    const patch = ["@@ -0,0 +1,1 @@", `+token = "ghp_${"a".repeat(36)}"`].join("\n");
    const findings = provider.scanDiff(patch);
    expect(findings.some((f) => f.pattern === "github-token")).toBe(true);
  });

  it("catches a generic high-entropy token even without a named pattern", () => {
    const patch = ["@@ -0,0 +1,1 @@", '+const secretValue = "Xk9mQzP2vL7wR4tYbN8cJ3aE6Zp5Uq";'].join("\n");
    const findings = provider.scanDiff(patch);
    expect(findings.length).toBeGreaterThan(0);
  });

  it("ignores removed lines and diff metadata, only scanning additions", () => {
    const patch = [
      "diff --git a/f b/f",
      "--- a/f",
      "+++ b/f",
      "@@ -1,1 +1,1 @@",
      "-AWS_KEY = 'AKIAABCDEFGHIJKLMNOP'",
      "+AWS_KEY = 'redacted'",
    ].join("\n");
    expect(provider.scanDiff(patch)).toHaveLength(0);
  });

  it("does not flag ordinary code", () => {
    const patch = ["@@ -0,0 +1,2 @@", "+function add(a, b) {", "+  return a + b;"].join("\n");
    expect(provider.scanDiff(patch)).toHaveLength(0);
  });

  it("tracks line numbers across multiple hunks", () => {
    const patch = [
      "@@ -1,1 +1,1 @@",
      "+clean line",
      "@@ -10,1 +12,1 @@",
      "+AWS_KEY = 'AKIAABCDEFGHIJKLMNOP'",
    ].join("\n");
    const findings = provider.scanDiff(patch);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.line).toBe(12);
  });
});
