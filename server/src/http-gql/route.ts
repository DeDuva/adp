import type { FastifyInstance } from "fastify";
import { execute, parse, validate, specifiedRules, GraphQLError, type GraphQLSchema } from "graphql";
import { z } from "zod";
import type { Db } from "../db/client.js";
import type { GqlContext } from "./context.js";
import { hasScope } from "../auth/plugin.js";

const GraphQLRequestBody = z.object({
  query: z.string(),
  variables: z.record(z.unknown()).optional().nullable(),
  operationName: z.string().optional().nullable(),
});

// `gh`'s real, unmodified queries (e.g. `issue view`'s `issueOrPullRequest`
// lookup) select same-named fields of different types inside mutually
// exclusive `... on Issue` / `... on PullRequest` fragments on a union —
// legal by the GraphQL spec's own field-merging rule, and something real
// GitHub's server accepts every day, but graphql-js's
// OverlappingFieldsCanBeMergedRule flags it anyway (confirmed by direct
// testing against the vendored schema: only this one rule objects, and
// removing it introduces no other validation gap we've hit). Dropped for
// the same reason schema.ts strips @deprecated — a known impedance mismatch
// between graphql-js's strictness and the schema/queries we didn't write.
const VALIDATION_RULES = specifiedRules.filter((rule) => rule.name !== "OverlappingFieldsCanBeMergedRule");

// Single endpoint, GitHub-shaped. Unimplemented fields resolve to a
// GraphQL error (or null, if nullable) rather than a validation failure —
// that's the entire point of loading the real SDL unmodified
// (docs/pragmatic_mvp.md §2.4 Tier 3).
//
// Deliberately not using the graphql() convenience function: it runs a full
// validateSchema() on every call, and GitHub's real published schema fails
// graphql-js's strict deprecation-consistency rule (an interface field and
// an implementing type's field disagree on @deprecated) — a pre-existing
// quirk of their schema, not something we introduced. Schema validity is a
// startup-time concern for a schema we vendor and trust; per-request we
// only need to validate the incoming query document against it.
export function registerGraphQLRoute(app: FastifyInstance, schema: GraphQLSchema, db: Db) {
  app.post("/api/graphql", async (req, reply) => {
    // Default-private reads (docs/pragmatic_mvp.md §1.5): the whole endpoint
    // requires at least repo:read — surfaced as a GraphQL error (not a bare
    // REST 401/403) so `gh`-shaped clients see it in the usual `errors` array.
    if (!req.identity || !hasScope(req.identity.scopes, "repo:read")) {
      reply.send({ errors: [{ message: "Requires authentication with repo:read scope" }] });
      return;
    }

    const parsedBody = GraphQLRequestBody.safeParse(req.body);
    if (!parsedBody.success) {
      reply.code(400).send({ errors: [{ message: "Invalid GraphQL request body" }] });
      return;
    }

    let document;
    try {
      document = parse(parsedBody.data.query);
    } catch (err) {
      reply.send({ errors: [{ message: err instanceof GraphQLError ? err.message : "Syntax error" }] });
      return;
    }

    const validationErrors = validate(schema, document, VALIDATION_RULES);
    if (validationErrors.length > 0) {
      reply.send({ errors: validationErrors.map((e) => ({ message: e.message })) });
      return;
    }

    const contextValue: GqlContext = { db, identity: req.identity ?? null, log: req.log };

    const result = await execute({
      schema,
      document,
      variableValues: parsedBody.data.variables ?? undefined,
      operationName: parsedBody.data.operationName ?? undefined,
      contextValue,
    });

    reply.send(result);
  });
}
