import type { FastifyInstance } from "fastify";
import { execute, parse, validate, GraphQLError, type GraphQLSchema } from "graphql";
import { z } from "zod";
import type { Db } from "../db/client.js";
import type { GqlContext } from "./context.js";

const GraphQLRequestBody = z.object({
  query: z.string(),
  variables: z.record(z.unknown()).optional().nullable(),
  operationName: z.string().optional().nullable(),
});

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

    const validationErrors = validate(schema, document);
    if (validationErrors.length > 0) {
      reply.send({ errors: validationErrors.map((e) => ({ message: e.message })) });
      return;
    }

    const contextValue: GqlContext = { db, identity: req.identity ?? null };

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
