import { describe, it, expect } from "vitest";
import {
  resolveLandRequirements,
  EMPTY_POLICY,
  DEFAULT_STATISTICAL_POLICY,
  DEFAULT_TRAJECTORY_POLICY,
  type RepoPolicy,
} from "./repo-policy.js";

describe("resolveLandRequirements", () => {
  it("is just the instance floor when neither org nor repo has a policy", () => {
    expect(resolveLandRequirements(["gates_green"], [], EMPTY_POLICY)).toEqual(["gates_green"]);
  });

  it("unions the floor with the repo's own requirements", () => {
    const repoPolicy: RepoPolicy = { gates: ["tests"], land: { require: ["one_approval"], statistical: DEFAULT_STATISTICAL_POLICY }, trajectory: DEFAULT_TRAJECTORY_POLICY };
    expect(resolveLandRequirements(["gates_green"], [], repoPolicy).sort()).toEqual(
      ["gates_green", "one_approval"].sort(),
    );
  });

  it("a repo can only add requirements, never remove a floor one", () => {
    const repoPolicy: RepoPolicy = { gates: [], land: { require: [], statistical: DEFAULT_STATISTICAL_POLICY }, trajectory: DEFAULT_TRAJECTORY_POLICY };
    expect(resolveLandRequirements(["gates_green", "one_approval"], [], repoPolicy)).toEqual([
      "gates_green",
      "one_approval",
    ]);
  });

  it("dedups when both the floor and the repo name the same requirement", () => {
    const repoPolicy: RepoPolicy = { gates: [], land: { require: ["gates_green"], statistical: DEFAULT_STATISTICAL_POLICY }, trajectory: DEFAULT_TRAJECTORY_POLICY };
    expect(resolveLandRequirements(["gates_green"], [], repoPolicy)).toEqual(["gates_green"]);
  });

  it("is empty when nothing at any level requires anything", () => {
    expect(resolveLandRequirements([], [], EMPTY_POLICY)).toEqual([]);
  });

  // M4-2: the org policy plane adds a third level, additive same as the
  // other two.
  it("unions the org floor in alongside the instance floor and the repo's own", () => {
    const repoPolicy: RepoPolicy = { gates: [], land: { require: ["one_approval"], statistical: DEFAULT_STATISTICAL_POLICY }, trajectory: DEFAULT_TRAJECTORY_POLICY };
    expect(resolveLandRequirements(["gates_green"], ["gates_confident"], repoPolicy).sort()).toEqual(
      ["gates_confident", "gates_green", "one_approval"].sort(),
    );
  });

  it("an org can only add requirements, never remove an instance-floor one", () => {
    expect(resolveLandRequirements(["gates_green", "one_approval"], [], EMPTY_POLICY)).toEqual([
      "gates_green",
      "one_approval",
    ]);
  });

  it("dedups across all three levels, not just floor-vs-repo", () => {
    const repoPolicy: RepoPolicy = { gates: [], land: { require: ["gates_green"], statistical: DEFAULT_STATISTICAL_POLICY }, trajectory: DEFAULT_TRAJECTORY_POLICY };
    expect(resolveLandRequirements(["gates_green"], ["gates_green"], repoPolicy)).toEqual(["gates_green"]);
  });
});
