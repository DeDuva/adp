import type { FastifyInstance } from "fastify";

// The README makes a promise about this server's 404s:
//
//   "Unimplemented REST endpoints return 404 with a body naming the ADP
//    equivalent. A broken call that explains itself costs an agent one turn;
//    a hang or a 500 costs it the trajectory."
//
// ...and then lists eleven families as not served. On 2026-09-01 that promise
// was kept by exactly one route — the Actions passthrough in `actions.ts`,
// which is a real handler that happens to answer 404 for a non-mirrored repo.
// Every other family returned Fastify's stock body:
//
//   {"message":"Route GET:/api/v3/search/issues not found",
//    "error":"Not Found","statusCode":404}
//
// which names nothing, and is exactly the shape the promise exists to rule out.
// The worst instance was `/users/{owner}`: it is the route whose absence makes
// `gh repo create` fail, the README knows the replacement, and the 404 an agent
// actually received did not.
//
// **This is a not-found handler and not a set of routes, deliberately.**
// `spec-coverage.test.ts` fails when the server serves a route
// `spec/openapi.yaml` does not describe, and it is right to: the spec is a
// published contract and a downstream consumer generates its client from it.
// Registering eleven families of stubs to improve their error bodies would mean
// either eleven families of spec entries describing endpoints that do nothing,
// or a hole in the guard. A not-found handler serves no route, appears in no
// route table, and changes no generated client — it only replaces the body on
// the way out.
//
// The rule for adding an entry: name the ADP capability that replaces it, or do
// not add one. "Not supported" with no alternative is what the stock 404
// already says, and a longer way of saying it helps nobody.

type NotImplemented = {
  /** Matched against the path after `/api/v3`. */
  pattern: RegExp;
  what: string;
  /** What to do instead — the whole reason this file exists. */
  instead: string;
};

// Ordered: the first match wins, so anything narrow goes above the family that
// would also match it.
const FAMILIES: NotImplemented[] = [
  {
    pattern: /^\/users\/[^/]+$/,
    what: "User lookup is not served — ADP has principals and organizations, not user profiles",
    instead:
      "This is what makes `gh repo create` fail: it resolves the owner here before creating. " +
      "Create repositories with POST /api/v3/repos/{owner} instead — `gh api -X POST /repos/{owner} -f name={repo}`.",
  },
  {
    pattern: /^\/search\b/,
    what: "Search is not served",
    instead:
      "The operation log is the queryable surface: GET /api/adp/repos/{owner}/{repo}/operations " +
      "filters by actor, verb, date range and file path. Issues and proposals list with " +
      "GET /api/v3/repos/{owner}/{repo}/issues and /pulls.",
  },
  {
    pattern: /^\/repos\/[^/]+\/[^/]+\/releases\b/,
    what: "Releases are not served",
    instead:
      "ADP versions the contract, not your artifacts. What a release would point at is the change " +
      "record: GET /api/adp/repos/{owner}/{repo}/evidence/{sha} is the signed bundle for a landed commit.",
  },
  {
    pattern: /^\/repos\/[^/]+\/[^/]+\/branches\/.+\/protection\b/,
    what: "Branch protection is not served as an API surface, on purpose",
    instead:
      "The land policy replaces it and is stronger: an instance floor, the org floor and the repo's " +
      "own adp.yaml, unioned so no level can remove another's requirement. Set `land.require` in " +
      "adp.yaml on the base ref; read the effective policy from a refused merge, which names each " +
      "unmet requirement and the command that satisfies it.",
  },
  {
    pattern: /^\/repos\/[^/]+\/[^/]+\/code-scanning\b/,
    what: "Code scanning is not served as an API surface, on purpose",
    instead:
      "Scanners report as gates. POST /api/v3/repos/{owner}/{repo}/gates signs and stores a result; " +
      "`adapters/` holds osv-scanner and wizcli adapters. Push protection is separate and always on: " +
      "the pre-receive hook rejects a secret at the wire.",
  },
  {
    pattern: /^\/repos\/[^/]+\/[^/]+\/dependabot\b/,
    what: "Dependabot is not served as an API surface, on purpose",
    instead:
      "Dependency admission is a gate at the point code enters, not a bot filing proposals: see " +
      "POST /api/v3/repos/{owner}/{repo}/dependency-admission.",
  },
  {
    pattern: /^\/repos\/[^/]+\/[^/]+\/deployments\b/,
    what: "Deployments are not served",
    instead:
      "ADP does not deploy. It makes the deployed change identifiable and reversible: " +
      "GET /api/adp/repos/{owner}/{repo}/operations, and POST .../operations/{id}/undo.",
  },
  {
    pattern: /^\/repos\/[^/]+\/[^/]+\/(packages|keys|hooks)\b/,
    what: "Packages, deploy keys and repository webhooks are not served",
    instead:
      "Authentication is bearer tokens with repo:read / repo:write / admin scopes. Mirror mode " +
      "configures its own webhook through POST /api/v3/repos/{owner}/{repo}/mirror.",
  },
  {
    pattern: /^\/(orgs|teams|user\/orgs)\b/,
    what: "GitHub-shaped organization and team endpoints are not served",
    instead:
      "Organizations are native: GET/POST /api/adp/orgs, and PATCH /api/adp/orgs/{org} for quotas " +
      "and the policy floor. There are no teams — membership is per organization.",
  },
  {
    pattern: /^\/(projects|repos\/[^/]+\/[^/]+\/projects)\b/,
    what: "Projects are not served",
    instead:
      "An intent is the unit of planned work: file it as an issue, and a pushed commit binds to it " +
      "through an ADP-Intent trailer. Candidate sets (POST /api/adp/repos/{owner}/{repo}/candidate-sets) " +
      "express N competing solutions to one intent.",
  },
  {
    pattern: /^\/(notifications|gists)\b/,
    what: "Notifications and gists are not served",
    instead: "There is no equivalent, and none is planned — neither is part of admitting a change.",
  },
];

/**
 * Register the enriching not-found handler.
 *
 * Anything outside `/api/v3` keeps Fastify's stock body verbatim, including the
 * git wire routes and `/ui/*`: a 404 there is read by git or a browser, and
 * neither wants prose. Nor does a matched family change the *status* — 404 is
 * the right answer and the promise is only about the body.
 */
export function registerNotImplementedHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split("?")[0] ?? "";
    if (!url.startsWith("/api/v3")) {
      reply.code(404).send({
        message: `Route ${req.method}:${url} not found`,
        error: "Not Found",
        statusCode: 404,
      });
      return;
    }

    const rest = url.slice("/api/v3".length) || "/";
    const family = FAMILIES.find((f) => f.pattern.test(rest));
    reply.code(404).send({
      message: family ? family.what : `Route ${req.method}:${url} not found`,
      documentation_url: "https://github.com/DeDuva/adp/blob/main/README.md",
      // Named `adp_equivalent` because actions.ts already answers with that
      // key, and an agent that learned to read one 404 should not have to learn
      // a second shape to read the next.
      ...(family ? { adp_equivalent: family.instead } : {}),
      error: "Not Found",
      statusCode: 404,
    });
  });
}
