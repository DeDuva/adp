import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(new URL(".", import.meta.url).pathname, "..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  name: string;
  private?: boolean;
  bin: Record<string, string>;
  files: string[];
  publishConfig?: { access?: string };
  dependencies?: Record<string, string>;
  scripts: Record<string, string>;
};

// #235 — the CLI is obtainable.
//
// It was `private: true` and the only documented install was a source build, so
// ADP could not be had without cloning it: every front door this phase widened
// opened onto a building with no road.
//
// This is a test rather than a note because the failure is silent. A package
// that quietly goes back to `private`, or loses `dist` from `files`, publishes
// something broken or publishes nothing — and either way the release workflow
// stays green and nobody finds out until a stranger tries to install it.
describe("#235: the CLI is publishable", () => {
  it("is not private, and is scoped to a name a stranger can install", () => {
    expect(manifest.private).toBeUndefined();
    expect(manifest.name).toBe("@deduva/adp");
    // Scoped packages default to restricted, which would publish successfully
    // and be unreachable — the worst of the available outcomes.
    expect(manifest.publishConfig?.access).toBe("public");
  });

  it("ships the built entrypoint its bin points at, and nothing else", () => {
    expect(manifest.bin.adp).toBe("./dist/index.js");
    expect(manifest.files).toContain("dist");
    // The source is deliberately not in the tarball: `files` is an allowlist,
    // and shipping `src` doubles the download for something no consumer runs.
    expect(manifest.files).not.toContain("src");
  });

  it("has no runtime dependencies, so installing it is one download", () => {
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it("builds before it publishes, so `dist` cannot be stale or absent", () => {
    expect(manifest.scripts.prepublishOnly).toBe("npm run build");
  });

  it("has a README, because npm shows it as the package page", () => {
    expect(existsSync(path.join(root, "README.md"))).toBe(true);
    expect(manifest.files).toContain("README.md");
  });

  it("declares the entrypoint as an executable script", () => {
    // Without a shebang `npm install -g` produces a file on PATH that the shell
    // tries to run as a shell script.
    expect(readFileSync(path.join(root, "src/index.ts"), "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });
});
