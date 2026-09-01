import { describe, it, expect } from "vitest";
import { cutoffFor, retentionDaysFor, DEFAULT_RETENTION_DAYS } from "./trajectory-retention.js";

// The window arithmetic, which is where a retention policy goes wrong quietly:
// an off-by-one in a resolution rule deletes data nobody asked to delete, and
// it does so on a tick nobody is watching.
describe("retentionDaysFor", () => {
  it("defers upward when the org has set nothing", () => {
    expect(retentionDaysFor(null, 90)).toBe(90);
    expect(retentionDaysFor(null, 0)).toBe(0);
  });

  it("lets an org narrow or widen the instance window", () => {
    expect(retentionDaysFor(30, 90)).toBe(30);
    expect(retentionDaysFor(365, 90)).toBe(365);
  });

  // The distinction the whole column exists for: an org that has never been
  // configured and one that has chosen to keep everything are different states,
  // and only the second is spelled 0.
  it("treats an org's explicit zero as a choice, not as absence", () => {
    expect(retentionDaysFor(0, 90)).toBe(0);
    expect(retentionDaysFor(null, 90)).not.toBe(0);
  });
});

describe("cutoffFor", () => {
  it("is null for an unbounded window, so nothing is ever claimed", () => {
    expect(cutoffFor(0)).toBeNull();
    // Negative cannot arrive through the config schema, which is nonnegative;
    // guarded anyway, because "reduce everything" is the wrong way to fail.
    expect(cutoffFor(-1)).toBeNull();
  });

  it("puts the boundary exactly one window back", () => {
    const now = new Date("2026-09-01T00:00:00.000Z");
    expect(cutoffFor(90, now)!.toISOString()).toBe("2026-06-03T00:00:00.000Z");
    expect(cutoffFor(1, now)!.toISOString()).toBe("2026-08-31T00:00:00.000Z");
  });

  it("ships a window generous enough that upgrading is not a surprise", () => {
    expect(DEFAULT_RETENTION_DAYS).toBeGreaterThanOrEqual(30);
  });
});
