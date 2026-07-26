import type { GraphQLFieldResolver, GraphQLSchema } from "graphql";
import { isObjectType } from "graphql";

// `any` here, not `unknown`: each resolver in a ResolverMap has a concrete
// parent/context type (see resolvers.ts) narrower than the schema-wide
// GraphQLFieldResolver signature, which is only sound to assign under `any`.
export type ResolverMap = Record<string, Record<string, GraphQLFieldResolver<any, any>>>;

// schema built via buildSchema() has no resolvers attached — this mutates
// the parsed field configs in place, GitHub-real SDL, ADP resolvers.
// The alternative (graphql-tools' makeExecutableSchema) is a dependency we
// don't need for one small map.
export function attachResolvers(schema: GraphQLSchema, resolvers: ResolverMap): void {
  for (const [typeName, fields] of Object.entries(resolvers)) {
    const type = schema.getType(typeName);
    if (!type || !isObjectType(type)) {
      throw new Error(`attachResolvers: type '${typeName}' not found or not an object type`);
    }
    const typeFields = type.getFields();
    for (const [fieldName, resolve] of Object.entries(fields)) {
      const field = typeFields[fieldName];
      if (!field) {
        throw new Error(`attachResolvers: field '${typeName}.${fieldName}' not found in schema`);
      }
      field.resolve = resolve;
    }
  }
}
