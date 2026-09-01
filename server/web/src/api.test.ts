import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { EVENT_KINDS, RUN_STATUSES, LAND_REQUIREMENTS } from "./api.js";

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

  // #156: the trajectory's kind filter is rendered from this array, so a copy
  // that drifts renders a filter that silently cannot select a kind the server
  // writes — the same failure shape as the blank label above, one surface over.
  it("EVENT_KINDS matches core/trajectory.ts's EVENT_KINDS, both directions", () => {
    const source = readFileSync(new URL("../../src/core/trajectory.ts", import.meta.url), "utf8");
    const match = /export const EVENT_KINDS = \[([^\]]+)\] as const/.exec(source);
    expect(
      match,
      "core/trajectory.ts no longer declares EVENT_KINDS as a const array — update this test's extraction",
    ).not.toBeNull();
    const serverValues = match![1]!
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter(Boolean)
      .sort();

    expect([...EVENT_KINDS].sort()).toEqual(serverValues);
  });

  // Same argument for the status filter, whose values come from the column's
  // own enum in the schema.
  it("RUN_STATUSES matches core/runs.ts's RUN_STATUSES, both directions", () => {
    const source = readFileSync(new URL("../../src/core/runs.ts", import.meta.url), "utf8");
    const match = /export const RUN_STATUSES = \[([^\]]+)\] as const/.exec(source);
    expect(
      match,
      "core/runs.ts no longer declares RUN_STATUSES as a const array — update this test's extraction",
    ).not.toBeNull();
    const serverValues = match![1]!
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter(Boolean)
      .sort();

    expect([...RUN_STATUSES].sort()).toEqual(serverValues);
  });
});
