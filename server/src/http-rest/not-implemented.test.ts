import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerNotImplementedHandler } from "./not-implemented.js";

// The README's promise about this server's 404s, as a test rather than as
// prose: "Unimplemented REST endpoints return 404 with a body naming the ADP
// equivalent." It listed eleven families and was kept by one route, which is
// the sort of drift only an assertion catches — the claim reads as true right
// up until somebody checks a second endpoint.
//
// No database and no routes: the handler under test serves nothing, which is
// the property that lets it exist at all without `spec-coverage.test.ts`
// failing. Registering a real route here would test the opposite of the design.
describe("unimplemented REST families explain themselves", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    registerNotImplementedHandler(app);
    // One real route, so the test can tell "the handler did not shadow a route"
    // from "there were no routes to shadow".
    app.get("/api/v3/repos/:owner/:repo", async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // Every family the README lists as not served. A new entry in FAMILIES that
  // forgets its `instead` fails here rather than in front of an agent.
  const families: [string, string][] = [
    ["/api/v3/users/acme", "POST /api/v3/repos/{owner}"],
    ["/api/v3/search/issues", "operations"],
    ["/api/v3/repos/acme/widget/releases", "evidence"],
    ["/api/v3/repos/acme/widget/branches/main/protection", "land policy"],
    ["/api/v3/repos/acme/widget/code-scanning/alerts", "gates"],
    ["/api/v3/repos/acme/widget/dependabot/alerts", "dependency-admission"],
    ["/api/v3/repos/acme/widget/deployments", "undo"],
    ["/api/v3/repos/acme/widget/packages", "bearer tokens"],
    ["/api/v3/orgs/acme", "/api/adp/orgs"],
    ["/api/v3/projects/1", "candidate-sets"],
    ["/api/v3/gists", "no equivalent"],
  ];

  it.each(families)("%s names what to do instead", async (url, expected) => {
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.adp_equivalent, `${url} returned no adp_equivalent`).toBeTypeOf("string");
    expect(body.adp_equivalent).toContain(expected);
    expect(body.documentation_url).toContain("DeDuva/adp");
    // The status is not the part being changed. A 404 is the right answer for
    // a route that does not exist, and an agent that retries on 5xx must not
    // be told to retry this.
    expect(body.statusCode).toBe(404);
  });

  it("does not shadow a route that exists", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v3/repos/acme/widget" });
    expect(res.statusCode).toBe(200);
  });

  // `/users/{owner}` is the one that made `gh repo create` fail while the
  // README knew the replacement and the 404 did not say it. If this assertion
  // ever needs deleting, `make local` and the README's compatibility table are
  // both making a promise that goes with it.
  it("names the repo-create replacement on the route gh resolves the owner through", async () => {
    const body = (await app.inject({ method: "GET", url: "/api/v3/users/acme" })).json();
    expect(body.adp_equivalent).toContain("gh repo create");
    expect(body.adp_equivalent).toContain("POST /api/v3/repos/{owner}");
  });

  it("leaves 404s outside /api/v3 alone", async () => {
    const body = (await app.inject({ method: "GET", url: "/ui/missing" })).json();
    expect(body).not.toHaveProperty("adp_equivalent");
    expect(body).not.toHaveProperty("documentation_url");
    expect(body.message).toContain("not found");
  });

  it("keeps the stock message for an /api/v3 path in no listed family", async () => {
    const body = (await app.inject({ method: "GET", url: "/api/v3/nothing-like-this" })).json();
    expect(body).not.toHaveProperty("adp_equivalent");
    expect(body.message).toContain("/api/v3/nothing-like-this");
  });
});
