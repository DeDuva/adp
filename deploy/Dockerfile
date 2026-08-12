FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm install
COPY server/ ./
RUN npm run build

# The supervision UI, built in the same stage. main.ts serves ../web/dist
# relative to its own dist/, and falls back to a *log line* when that directory
# is missing — which is right for a fresh checkout running `npm run dev` and
# wrong here: until M4-12 this image never built the UI at all, so every
# self-hosted instance, the GCP dev box included, quietly served no /ui/* while
# looking entirely healthy. `docs/pragmatic_mvp.md` §4.6 counts the UI as part
# of the product, and M4-7 just put the org policy console behind it.
#
# `npm ci` rather than `npm install`: web/ has its own lockfile, and a
# self-hosting image should build the versions that were tested, not the
# versions that resolve today.
WORKDIR /app/server/web
COPY server/web/package.json server/web/package-lock.json* ./
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
# Static assets only — the UI's node_modules and sources stay in the build
# stage. Path matters: main.ts resolves it as dist/../web/dist.
COPY --from=build /app/server/web/dist ./web/dist
COPY server/drizzle ./drizzle
# schema.ts resolves this relative to the repo root at runtime (three levels
# up from dist/http-gql/), so it has to land at the same relative depth here.
COPY spec/graphql /app/spec/graphql
EXPOSE 3000
CMD ["node", "dist/main.js"]
