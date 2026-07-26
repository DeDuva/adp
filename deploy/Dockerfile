FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm install
COPY server/ ./
RUN npm run build

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/server/dist ./dist
COPY server/drizzle ./drizzle
# schema.ts resolves this relative to the repo root at runtime (three levels
# up from dist/http-gql/), so it has to land at the same relative depth here.
COPY spec/graphql /app/spec/graphql
EXPOSE 3000
CMD ["node", "dist/main.js"]
