import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { LAND_REQUIREMENTS } from "./api.js";

// #98 — the same argument as the server's observability-coverage, one
// package out. api.ts hand-copies server enums because this package
// deliberately does not import server code (it is a static bundle served BY
// the server), and a hand-copy that drifts does not fail, warn, or look
// broken: it renders a blank label. It HAD drifted — `gates_confident` was
// missing, and the case that exposed it was the malformed-policy
// fail-closed path, where the console claimed every requirement was
// enforced while rendering one invisibly.
//
// So this binds the copy to the source, both directions, by reading the
// server file this repo already contains. Not an import: the server's
// z.enum is runtime zod, and pulling zod + the server's module graph into
// the web bundle's test setup would be a heavier coupling than the one this
// test exists to police.
describe("api.ts enum copies match the server's source of truth", () => {
  it("LAND_REQUIREMENTS matches core/repo-policy.ts's z.enum, both directions", () => {
    const source = readFileSync(new URL("../../src/core/repo-policy.ts", import.meta.url), "utf8");
    const match = /LandRequirement = z\.enum\(\[([^\]]+)\]\)/.exec(source);
    expect(match, "core/repo-policy.ts no longer declares LandRequirement via z.enum — update this test's extraction").not.toBeNull();
    const serverValues = match![1]!
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter(Boolean)
      .sort();

    expect([...LAND_REQUIREMENTS].sort()).toEqual(serverValues);
  });
});
