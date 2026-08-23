#!/usr/bin/env bash
# Refreshes the vendored copy of GitHub's public GraphQL schema SDL.
# We load the real schema unmodified
# so `gh`'s queries validate against it and unimplemented fields fail as a
# resolver error, never a validation error. This dodges "perpetually
# chasing upstream" — the schema is upstream's artifact, we just refresh it.
set -euo pipefail
cd "$(dirname "$0")/.."
curl -sL https://raw.githubusercontent.com/octokit/graphql-schema/main/schema.graphql \
  -o spec/graphql/github.graphql
echo "Updated spec/graphql/github.graphql ($(wc -l < spec/graphql/github.graphql) lines)"
