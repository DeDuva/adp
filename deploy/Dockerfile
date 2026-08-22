FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm install
COPY server/ ./
RUN npm run build

# #101: the supervision UI ships in the production image. main.ts serves
# /ui/* only when web/dist exists beside dist/ — without this stage the
# published image silently served no UI at all, the same skip-looks-like-
# working failure the rest of the suite guards against. M4-12 found the same
# bug independently while verifying the Helm chart: the GCP dev box had been
# serving no /ui/* at all, with M4-7's org policy console behind it.
#
# Its own stage, so the UI's node_modules and sources never reach the server
# build stage — only the built assets are copied forward.
#
# `npm ci` rather than `npm install` (M4-12): web/ has its own lockfile, and a
# self-hosting image should build the versions that were tested, not the
# versions that resolve today.
FROM node:22-slim AS webbuild
WORKDIR /app/web
COPY server/web/package.json server/web/package-lock.json ./
RUN npm ci
COPY server/web/ ./
RUN npm run build

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/server/dist ./dist
# Path matters: main.ts resolves it as dist/../web/dist.
COPY --from=webbuild /app/web/dist ./web/dist
COPY server/drizzle ./drizzle
# schema.ts resolves this relative to the repo root at runtime (three levels
# up from dist/http-gql/), so it has to land at the same relative depth here.
COPY spec/graphql /app/spec/graphql
# Deploy-time build stamp for GET /version (#101) — the release workflow
# passes the commit it built; compose's runtime env can still override.
ARG ADP_GIT_SHA=""
ENV ADP_GIT_SHA=$ADP_GIT_SHA
EXPOSE 3000
CMD ["node", "dist/main.js"]
