import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "./concurrency.js";

describe("mapWithConcurrency", () => {
  it("returns results in input order, not completion order", async () => {
    const delays = [30, 5, 20, 1, 10];
    const out = await mapWithConcurrency(delays, 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4]);
  });

  // The whole point: a `repo:read` request must not be able to open as many
  // concurrent reads as the run has sessions.
  it("never runs more than the limit at once", async () => {
    let live = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 50 }, (_, i) => i), 4, async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 1));
      live--;
    });
    expect(peak).toBe(4);
  });

  it("uses no more workers than there are items", async () => {
    let peak = 0;
    let live = 0;
    await mapWithConcurrency([1, 2], 16, async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 1));
      live--;
    });
    expect(peak).toBe(2);
  });

  it("is a no-op on an empty list", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  // A read that failed must not be reported as a verification that found
  // nothing wrong, so the rejection propagates rather than being collected.
  it("propagates a rejection", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("refuses a limit below one rather than deadlocking", async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(RangeError);
  });
});
