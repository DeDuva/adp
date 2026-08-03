import { describe, it, expect } from "vitest";
import {
  resolveLandRequirements,
  EMPTY_POLICY,
  DEFAULT_STATISTICAL_POLICY,
  type RepoPolicy,
} from "./repo-policy.js";

describe("resolveLandRequirements", () => {
  it("is just the instance floor when the repo has no policy", () => {
    expect(resolveLandRequirements(["gates_green"], EMPTY_POLICY)).toEqual(["gates_green"]);
  });

  it("unions the floor with the repo's own requirements", () => {
    const repoPolicy: RepoPolicy = { gates: ["tests"], land: { require: ["one_approval"], statistical: DEFAULT_STATISTICAL_POLICY } };
    expect(resolveLandRequirements(["gates_green"], repoPolicy).sort()).toEqual(
      ["gates_green", "one_approval"].sort(),
    );
  });

  it("a repo can only add requirements, never remove a floor one", () => {
    const repoPolicy: RepoPolicy = { gates: [], land: { require: [], statistical: DEFAULT_STATISTICAL_POLICY } };
    expect(resolveLandRequirements(["gates_green", "one_approval"], repoPolicy)).toEqual([
      "gates_green",
      "one_approval",
    ]);
  });

  it("dedups when both the floor and the repo name the same requirement", () => {
    const repoPolicy: RepoPolicy = { gates: [], land: { require: ["gates_green"], statistical: DEFAULT_STATISTICAL_POLICY } };
    expect(resolveLandRequirements(["gates_green"], repoPolicy)).toEqual(["gates_green"]);
  });

  it("is empty when neither the floor nor the repo require anything", () => {
    expect(resolveLandRequirements([], EMPTY_POLICY)).toEqual([]);
  });
});
