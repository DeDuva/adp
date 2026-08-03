import { describe, it, expect } from "vitest";
import { wilsonLowerBound, zForOneSidedConfidence } from "./flake-stats.js";

// The A8 contribution rests on this arithmetic being right. A confidence bound
// that is wrong in the permissive direction discredits the claim more than not
// making it, so the expected values below were computed independently from the
// closed form rather than read off this implementation's own output.
describe("zForOneSidedConfidence", () => {
  it("matches the standard one-sided critical values", () => {
    expect(zForOneSidedConfidence(0.9)).toBeCloseTo(1.2815515655, 6);
    expect(zForOneSidedConfidence(0.95)).toBeCloseTo(1.644853627, 6);
    expect(zForOneSidedConfidence(0.975)).toBeCloseTo(1.9599639845, 6);
    expect(zForOneSidedConfidence(0.99)).toBeCloseTo(2.326347874, 6);
  });

  it("is one-sided, not two-sided — 95% is 1.645, not 1.96", () => {
    // Worth its own assertion: using the two-sided value would make every gate
    // look worse than it is and silently tighten the bar for everyone.
    expect(zForOneSidedConfidence(0.95)).toBeLessThan(1.9);
  });
});

describe("wilsonLowerBound", () => {
  // Wilson score interval, lower bound:
  //   centre = (p + z²/2n) / (1 + z²/n)
  //   margin = z/(1 + z²/n) · sqrt(p(1−p)/n + z²/4n²)
  it("matches values computed from the closed form at 95% confidence", () => {
    expect(wilsonLowerBound(5, 5, 0.95)).toBeCloseTo(0.648883, 5);
    expect(wilsonLowerBound(10, 10, 0.95)).toBeCloseTo(0.787058, 5);
    expect(wilsonLowerBound(8, 10, 0.95)).toBeCloseTo(0.540793, 5);
    expect(wilsonLowerBound(99, 100, 0.95)).toBeCloseTo(0.956418, 5);
  });

  it("never exceeds the observed rate, and never goes below zero", () => {
    for (const [k, n] of [
      [0, 1],
      [1, 2],
      [3, 7],
      [50, 100],
      [99, 100],
    ] as const) {
      const bound = wilsonLowerBound(k, n, 0.95);
      expect(bound).toBeGreaterThanOrEqual(0);
      expect(bound).toBeLessThanOrEqual(k / n);
    }
  });

  it("tightens toward the observed rate as evidence accumulates", () => {
    // The same 100% observed pass rate with more runs behind it: the bound
    // rises, which is the whole behaviour that makes this better than counting
    // successes and calling it green.
    const five = wilsonLowerBound(5, 5, 0.95);
    const twenty = wilsonLowerBound(20, 20, 0.95);
    const hundred = wilsonLowerBound(100, 100, 0.95);
    expect(twenty).toBeGreaterThan(five);
    expect(hundred).toBeGreaterThan(twenty);
    expect(hundred).toBeLessThan(1);
  });

  it("is strictly more conservative than Wald at small n", () => {
    // Wald for 5/5 is exactly [1, 1] — p̂ = 1 means zero estimated variance —
    // so a gate observed to pass five times would clear *any* threshold with
    // total confidence. That is the concrete reason this is Wilson.
    expect(wilsonLowerBound(5, 5, 0.95)).toBeLessThan(0.9);
  });

  it("is stricter at higher confidence", () => {
    expect(wilsonLowerBound(9, 10, 0.99)).toBeLessThan(wilsonLowerBound(9, 10, 0.9));
  });

  it("returns 0 for no observations rather than dividing by zero", () => {
    expect(wilsonLowerBound(0, 0, 0.95)).toBe(0);
  });
});
