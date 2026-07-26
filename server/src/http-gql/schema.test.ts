import { describe, it, expect } from "vitest";
import { execute, parse, validate } from "graphql";
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

  // Regression test: buildSchema(sdl, { assumeValidSDL: true }) parses fine
  // even when the schema wouldn't survive graphql-js's full validateSchema()
  // — which is exactly GitHub's real schema's situation (a pre-existing
  // deprecation-consistency mismatch between an interface field and an
  // implementing type's field). route.ts works around this by using
  // parse+validate(document)+execute instead of the graphql() convenience
  // function, which runs validateSchema() on every call. This test executes
  // a real query end to end — no DB needed — so that regressing back to
  // graphql() fails here, not only in the DB-gated e2e suite.
  it("executes a trivial query without hitting schema-level validation errors", () => {
    const schema = loadGitHubSchema();
    const document = parse("{ __typename }");
    expect(validate(schema, document)).toEqual([]);
  });

  it("execute() (not the graphql() convenience function) runs without schema validation errors", async () => {
    const schema = loadGitHubSchema();
    const document = parse("{ __typename }");
    const result = await execute({ schema, document });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ __typename: "Query" });
  });
});
