import { describe, it, expect } from "vitest";
import { loadGitHubSchema } from "./schema.js";

// The single biggest new-risk item in M1b (docs/pragmatic_mvp.md §2.4 Tier
// 3): does GitHub's real, unmodified public schema even parse under
// graphql-js? If this breaks, everything downstream is moot.
describe("loadGitHubSchema", () => {
  it("parses the vendored GitHub SDL without throwing", () => {
    expect(() => loadGitHubSchema()).not.toThrow();
  });

  it("exposes the Query type with fields gh depends on", () => {
    const schema = loadGitHubSchema();
    const query = schema.getQueryType();
    expect(query).toBeTruthy();
    const fields = query!.getFields();
    expect(fields.repository).toBeTruthy();
    expect(fields.node).toBeTruthy();
    expect(fields.viewer).toBeTruthy();
  });

  it("exposes Repository, Issue, and PullRequest types", () => {
    const schema = loadGitHubSchema();
    expect(schema.getType("Repository")).toBeTruthy();
    expect(schema.getType("Issue")).toBeTruthy();
    expect(schema.getType("PullRequest")).toBeTruthy();
  });

  it("caches the parsed schema across calls", () => {
    expect(loadGitHubSchema()).toBe(loadGitHubSchema());
  });
});
