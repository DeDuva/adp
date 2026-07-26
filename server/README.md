# ADP server — M0 walking skeleton

Fastify + PostgreSQL server. Two things work end to end: token-authenticated repo creation,
and git smart-HTTP (clone/push) proxied to the real `git http-backend` binary.

Not yet implemented: REST `/api/v3` beyond identity probes + repo create, GraphQL, gates,
evidence bundles, the native MCP plane. See `docs/pragmatic_mvp.md` for the milestone plan.

## Local development

Requires Node 22+, a `git` binary with `git-http-backend`, and a reachable Postgres.

```bash
cp ../deploy/.env.example .env   # then edit DATABASE_URL / GIT_ROOT / etc for local use
npm install
npm run migrate
npm run dev
```

Mint the first token (there's no signup flow yet — this is the bootstrap path):

```bash
npx tsx src/bootstrap.ts <your-username>
```

Then, against a running server:

```bash
curl -X POST http://localhost:3000/api/v3/repos/<owner> \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"hello"}'

git clone http://x-access-token:<token>@localhost:3000/<owner>/hello.git
```

## Docker Compose

See `../deploy/docker-compose.yml`. Copy `../deploy/.env.example` to `../deploy/.env`, fill in
real values (especially `SIGNING_KEY` and `PUBLIC_URL`), then:

```bash
cd ../deploy
docker compose up -d
```
