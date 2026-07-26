# The ADP server stack, piece by piece

Six tools you'll see across `server/` and `deploy/` — what each one actually does in this
repo, where its files live, and how to run it on your machine. No prior familiarity assumed.

## How it fits together

One request, five hand-offs. Here's what happens when a client runs `git push` or hits the
REST API:

```
client (git / gh / curl)
  -> Caddy            (TLS, reverse proxy)
  -> Fastify           (auth, routes)
  -> Postgres          (via Drizzle)

  -> also, for git: git http-backend (the real git binary, shelled out)
```

All of it — Postgres, the Fastify server, Caddy — is started together with **Docker
Compose**, which is the orchestrator, not a separate moving part in the request path.

The rest of this doc walks each box left to right, then bottom to top: language and
framework first, then storage, then the edge, then how to switch it all on.

## Node.js & TypeScript — runtime + language

Node.js is what executes the server's JavaScript outside a browser. TypeScript is
JavaScript with types bolted on — you write `.ts` files, and a compiler (`tsc`) checks them
and turns them into plain `.js` that Node can run. The types themselves vanish at build
time; they exist purely to catch mistakes before they ship.

**Files:** `server/tsconfig.json`, `server/src/**/*.ts`

Two settings worth knowing about, both in `tsconfig.json`: `"strict": true` turns on
TypeScript's full set of safety checks, and `"module": "NodeNext"` means the code uses
modern `import`/`export` syntax rather than older `require()` calls.

```bash
# compiles server/src/**/*.ts -> server/dist/**/*.js
npm run build

# or: run TypeScript directly, no separate build step, restarts on save
npm run dev
```

You will not typically run `tsc` by hand — `npm run dev` (via a tool called `tsx`) runs the
TypeScript straight, and `npm run build` is what Docker uses to produce the deployed
`dist/` folder.

## Fastify — HTTP framework

Fastify is the library that turns "a request came in on port 3000" into "call this
function." It's the same category of tool as Express or Koa — you register routes, it
matches incoming requests against them and calls your handler. ADP picked Fastify
specifically because its routes can be described with a schema, which is what lets
`spec/openapi.yaml` and the server's actual routes stay in sync.

**Files:** `server/src/main.ts`, `server/src/http-rest/*.ts`, `server/src/http-git/proxy.ts`,
`server/src/auth/plugin.ts`

`main.ts` is the entry point: it builds the Fastify app, registers the auth plugin as a hook
that runs before every request, then registers three groups of routes — identity probes,
repo creation, and the git smart-HTTP proxy.

```ts
// server/src/main.ts — simplified
const app = Fastify({ logger: true });
await app.register(authPlugin(db));      // runs on every request
registerRepoRoutes(app, db, gitBackend); // POST /api/v3/repos/:owner
await app.listen({ host: "0.0.0.0", port: config.PORT });
```

"Registering a plugin" is Fastify's term for wiring in a self-contained piece of behavior —
auth, in this case — without every route file needing to know how tokens are checked.

## PostgreSQL — database

Postgres is where every non-git fact lives: which repos exist, who has which token, and the
append-only `operations` log that records every mutation. It's a separate process from the
Fastify server — they talk over a network connection, which is why local development needs
Postgres running before the server will boot.

**Files:** `server/src/db/schema.ts`, `server/src/db/client.ts`

| table | what it holds |
|---|---|
| `repos` | owner, name, default branch — one row per git repository |
| `identities` | humans or agents that can act against the server |
| `tokens` | hashed bearer tokens, each tied to one identity and a set of scopes |
| `operations` | append-only: every mutation, written in the same transaction as the change itself |

You never write raw SQL against these by hand day to day — that's what Drizzle, next, is
for.

## Drizzle — ORM & migrations

An ORM lets you describe database tables as TypeScript objects and query them with
TypeScript function calls instead of hand-written SQL strings. Drizzle is the ORM here, and
it does two distinct jobs: **querying** (reading and writing rows from application code) and
**migrations** (turning changes to `schema.ts` into the SQL statements that actually alter
the database).

**Files:** `server/src/db/schema.ts`, `server/drizzle.config.ts`, `server/drizzle/*.sql`

The schema is the source of truth. Change a table in `schema.ts`, then ask Drizzle to diff
it against the last known state and write a migration file:

```bash
# reads schema.ts, writes a new .sql file under server/drizzle/
npx drizzle-kit generate

# applies any migrations not yet run, behind a Postgres advisory lock
npm run migrate
```

That advisory lock matters once more than one server instance exists: it stops two boots
from racing to apply the same migration twice. See `server/src/db/migrate.ts`.

## Caddy — reverse proxy & TLS

Caddy sits in front of the Fastify server and is the thing that actually holds the public
port (443). Its two jobs: get a real HTTPS certificate automatically (no manual certbot
dance), and forward every request through to the server process running on an internal
port. Clients — including `gh`, which insists on HTTPS for anything that isn't literally
`github.com` — never talk to Fastify directly.

**Files:** `deploy/Caddyfile`

```
{$PUBLIC_URL} {
	reverse_proxy server:3000
}
```

That's the entire config. `{$PUBLIC_URL}` is your domain, read from the environment;
everything else — certificate issuance, renewal, HTTP→HTTPS redirects — is Caddy's default
behavior. On a local machine without a real domain, you'll usually skip Caddy and hit the
Fastify server on `localhost:3000` directly instead.

## Docker Compose — orchestration

Everything above — Postgres, the server, Caddy — can run as its own container. Docker
Compose is the file that says which containers to start, what to name them, which ports and
volumes they get, and which ones must be healthy before another one starts. One command
brings the whole stack up.

**Files:** `deploy/docker-compose.yml`, `deploy/Dockerfile`, `deploy/.env.example`

| service | role |
|---|---|
| `postgres` | the database, with a named volume so data survives restarts |
| `server` | builds from `deploy/Dockerfile`, runs migrations then boots Fastify |
| `caddy` | the only service exposed to the internet, on 80/443 |

```bash
# from deploy/
cp .env.example .env   # then fill in SIGNING_KEY, PUBLIC_URL, etc.
docker compose up -d
```

## Running it locally

Without Docker — talking to each piece directly. Requires Node 22+ and a reachable
Postgres.

1. **Install dependencies**
   ```bash
   # from server/
   npm install
   ```

2. **Point it at a Postgres instance.** Copy the example env file and fill in a real
   `DATABASE_URL`, plus `GIT_ROOT` (where bare repos are stored on disk) and a
   `SIGNING_KEY`.
   ```bash
   # from server/
   cp ../deploy/.env.example .env
   # edit .env: DATABASE_URL, GIT_ROOT, SIGNING_KEY, PUBLIC_URL
   ```

3. **Apply migrations**
   ```bash
   npm run migrate
   ```

4. **Start the server**
   ```bash
   npm run dev   # tsx watch — restarts on file changes
   ```

5. **Mint yourself a token.** There's no signup flow yet — this bootstrap script creates
   one identity and hands you back its token directly.
   ```bash
   # from server/
   npx tsx src/bootstrap.ts your-username
   ```

6. **Create a repo, then clone it**
   ```bash
   curl -X POST http://localhost:3000/api/v3/repos/your-username \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{"name":"hello"}'

   git clone http://x-access-token:<token>@localhost:3000/your-username/hello.git
   ```

> **No Postgres on hand?** The quickest path is Docker Compose (previous section) — it
> starts Postgres for you as part of the stack, so you skip steps 2–3 above entirely.

## Glossary

| term | meaning |
|---|---|
| bare repo | a git repository with no working directory — just the `.git` internals. What a server hosts; what you clone *from*, never edit directly. |
| smart-HTTP | the protocol `git clone`/`push` use over HTTP(S). ADP delegates it entirely to the real `git http-backend` binary rather than reimplementing it. |
| migration | a versioned SQL file that moves the database schema from one state to the next. Applied in order, never edited after the fact. |
| reverse proxy | a server that sits in front of another server, forwarding requests to it. Caddy's role here. |
| bearer token | a secret string sent as `Authorization: Bearer <token>` that proves who's making a request, in place of a username/password per call. |
| ORM | object-relational mapper — a library that lets you query a SQL database using the host language's data structures instead of raw SQL strings. |

---

Reflects the M0 walking skeleton in `server/` and `deploy/`. Later milestones add GraphQL,
gate runners, and the native MCP plane on top of this same stack — nothing here gets
replaced, only added to.
