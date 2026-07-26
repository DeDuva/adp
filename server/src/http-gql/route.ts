import type { FastifyInstance } from "fastify";
import { graphql, type GraphQLSchema } from "graphql";
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
export function registerGraphQLRoute(app: FastifyInstance, schema: GraphQLSchema, db: Db) {
  app.post("/api/graphql", async (req, reply) => {
    const parsed = GraphQLRequestBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ errors: [{ message: "Invalid GraphQL request body" }] });
      return;
    }

    const contextValue: GqlContext = { db, identity: req.identity ?? null };

    const result = await graphql({
      schema,
      source: parsed.data.query,
      variableValues: parsed.data.variables ?? undefined,
      operationName: parsed.data.operationName ?? undefined,
      contextValue,
    });

    reply.send(result);
  });
}
