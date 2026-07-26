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

// The vendored SDL has ~150 uses of @deprecated where an interface field
// and an implementing type's field disagree on deprecation status — a
// pre-existing quirk of this schema (not something we introduced) that
// graphql-js's assertValidSchema() rejects. buildSchema's assumeValidSDL
// skips that check, but validate() and execute() both re-run it internally
// with no public opt-out, so it has to be gone before any query can run.
// We don't use @deprecated for anything, so stripping it is lossless for
// us. The file on disk stays exactly as fetched; this transform happens at
// load time so refreshing the schema stays a clean diff against upstream.
function stripDeprecatedDirectives(sdl: string): string {
  // reason strings can themselves contain parentheses (e.g. "Projects
  // (classic) is being deprecated..."), so this matches a properly quoted
  // string body rather than balancing on the first ')'.
  return sdl.replace(/\s*@deprecated(\(\s*reason:\s*"(?:\\.|[^"\\])*"\s*\))?/g, "");
}

export function loadGitHubSchema(): GraphQLSchema {
  if (!cachedSchema) {
    const sdl = readFileSync(SCHEMA_PATH, "utf8");
    cachedSchema = buildSchema(stripDeprecatedDirectives(sdl), { assumeValidSDL: true });
  }
  return cachedSchema;
}
