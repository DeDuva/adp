import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { componentsFromNpmLockfile } from "./sbom.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../test/fixtures");

describe("componentsFromNpmLockfile", () => {
  it("extracts components from a real npm lockfile (a real `npm install is-odd lodash@4.17.15`)", () => {
    const lockfile = readFileSync(path.join(FIXTURES, "sbom-package-lock.json"), "utf8");
    const components = componentsFromNpmLockfile(lockfile);

    expect(components).toContainEqual({
      type: "library",
      name: "is-odd",
      version: "3.0.1",
      purl: "pkg:npm/is-odd@3.0.1",
    });
    expect(components).toContainEqual({
      type: "library",
      name: "lodash",
      version: "4.17.15",
      purl: "pkg:npm/lodash@4.17.15",
    });
    // is-odd's own transitive dependency, not just the two directly installed.
    expect(components.some((c) => c.name === "is-number")).toBe(true);
    // The root project itself ("" key in `packages`) is not a dependency.
    expect(components.some((c) => c.name === "sbom-fixture")).toBe(false);
  });

  it("dedups an identical name@version pair appearing at multiple install paths", () => {
    const lockfile = JSON.stringify({
      packages: {
        "": { name: "root", version: "1.0.0" },
        "node_modules/foo": { version: "1.0.0" },
        "node_modules/bar/node_modules/foo": { version: "1.0.0" },
        "node_modules/bar/node_modules/baz": { version: "2.0.0" },
      },
    });
    const components = componentsFromNpmLockfile(lockfile);
    expect(components.filter((c) => c.name === "foo")).toHaveLength(1);
    expect(components).toHaveLength(2); // foo (deduped) + baz
  });

  it("keeps two different versions of the same package as distinct components", () => {
    const lockfile = JSON.stringify({
      packages: {
        "node_modules/foo": { version: "1.0.0" },
        "node_modules/bar/node_modules/foo": { version: "2.0.0" },
      },
    });
    const components = componentsFromNpmLockfile(lockfile);
    expect(components.map((c) => c.version).sort()).toEqual(["1.0.0", "2.0.0"]);
  });

  it("handles a scoped package name (@scope/name), keeping purl's namespace/name separator literal", () => {
    // Verified against purl-spec's own worked example
    // (pkg:npm/%40angular/animation@12.3.1) — the "/" between namespace and
    // name is purl's structural separator, not part of an opaque encoded
    // blob.
    const lockfile = JSON.stringify({ packages: { "node_modules/@babel/core": { version: "7.24.0" } } });
    const components = componentsFromNpmLockfile(lockfile);
    expect(components).toEqual([
      { type: "library", name: "@babel/core", version: "7.24.0", purl: "pkg:npm/%40babel/core@7.24.0" },
    ]);
  });

  it("returns an empty component list for a lockfile with no packages", () => {
    expect(componentsFromNpmLockfile(JSON.stringify({ packages: {} }))).toEqual([]);
  });

  it("skips entries with no version (link/workspace references)", () => {
    const lockfile = JSON.stringify({ packages: { "node_modules/linked": {} } });
    expect(componentsFromNpmLockfile(lockfile)).toEqual([]);
  });
});
