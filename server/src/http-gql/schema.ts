import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSchema, type GraphQLSchema } from "graphql";

// GitHub's real public schema, vendored unmodified (scripts/update-graphql-schema.sh).
// Loading it as-is — rather than hand-rolling our own subset — means `gh`'s
// queries validate correctly; only fields we haven't backed with a resolver
// fail, and they fail as a resolver error, never "field does not exist"
// (docs/pragmatic_mvp.md §2.4 Tier 3).
const SCHEMA_PATH = fileURLToPath(new URL("../../../spec/graphql/github.graphql", import.meta.url));

let cachedSchema: GraphQLSchema | undefined;

export function loadGitHubSchema(): GraphQLSchema {
  if (!cachedSchema) {
    const sdl = readFileSync(SCHEMA_PATH, "utf8");
    cachedSchema = buildSchema(sdl, { assumeValidSDL: true });
  }
  return cachedSchema;
}
