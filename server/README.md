# ADP server — M0 skeleton + M1a + M1b read slice

Fastify + PostgreSQL server. Working end to end: token-authenticated repo creation, git
smart-HTTP (clone/push) proxied to the real `git http-backend` binary, issues (which each
file an intent) with comments, typed changes (a git commit bound to an intent and a
server-signed provenance record), proposals (PR-shaped, opened against a head/base branch),
typed reviews, fast-forward-only merge, and a GraphQL read path at `/api/graphql` backed by
GitHub's real, unmodified public schema (`spec/graphql/github.graphql`).

**GraphQL scope, precisely:** `Query.repository`, `Query.node`, `Query.viewer`,
`Repository.{owner,defaultBranchRef,issue,issues,pullRequest,pullRequests}`,
`Issue.author`, `PullRequest.author` have resolvers — enough to back `gh repo view`,
`gh issue list`/`view`, `gh pr list`/`view` in principle. Mutations (`gh pr create`/`merge`/
`review`, `gh issue create`/`close`) are REST-only for now; GraphQL mutation resolvers are
next. **Not yet validated against the real `gh` binary** — that's the record-replay
conformance suite (`docs/pragmatic_mvp.md` §5), a separate follow-up. What's tested here is
that hand-written queries shaped like `gh`'s actually resolve correctly, and that fields we
haven't backed fail as a GraphQL resolver error, never a schema validation error — the
entire point of loading the real SDL unmodified.

Not yet implemented: GraphQL mutations, gate runners, evidence bundles, land policy beyond
fast-forward, the native MCP plane, candidate sets, and automatic change recording on push
(changes are currently recorded via an explicit API call, not a git hook). Proposal/issue
numbering are independent sequences rather than GitHub's shared one — a known fidelity gap.
Refresh the vendored GraphQL schema with `scripts/update-graphql-schema.sh`.
See `docs/pragmatic_mvp.md` for the milestone plan.

## Local development

Requires Node 22 (pinned in `../.nvmrc`), a `git` binary with `git-http-backend`, and a
reachable Postgres. Check all of that in one shot before anything else:

```bash
bash ../scripts/dev/doctor.sh
```

```bash
cp ../deploy/.env.example .env   # then edit DATABASE_URL / GIT_ROOT / etc for local use
npm install
npm run migrate
npm run dev
```

`.env.example`'s `DATABASE_URL` points at the compose service hostname `postgres` and will
**not** resolve on the host — for local dev use the canonical local DSN
(`scripts/dev/config.sh`, shared with CI and the conformance gate):

```bash
export DATABASE_URL=postgres://adp:adp@localhost:5432/adp
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

## Testing

Three tiers, matching how much infrastructure each needs. All run under
[Vitest](https://vitest.dev); `npm test` runs the whole suite.

| Tier | Files | Needs | What it covers |
|---|---|---|---|
| Unit | `src/**/*.test.ts` (auth, config) | nothing | pure logic — token hashing, env validation |
| Integration | `src/**/*.test.ts` (git-backend, http-git proxy) | a real `git` binary (no DB) | bare repo creation, and a full `git clone`/`push` through Fastify into `git http-backend`, with auth stubbed to a fixed identity |
| End-to-end | `test/e2e.test.ts` | Postgres (`DATABASE_URL`) | the actual M0 exit criterion: mint a token, create a repo over REST, `git clone`/`push` with that token as the git password, confirm the commit landed |

The supported way to run the whole thing is from the repo root, against an ephemeral Postgres
that is created and destroyed per run (`docs/test-environment-automation.md`):

```bash
make up && make test-all && make down
```

`make down` asserts that nothing leaked — containers, volumes, server processes, temp
directories. Directly, without the Makefile:

```bash
npm test              # everything the current environment supports
npm run typecheck      # tsc --noEmit, including test files

# the full suite with the e2e tier actually enforced
ADP_REQUIRE_DB=1 DATABASE_URL=postgres://adp:adp@localhost:5432/adp npm test
```

The e2e suites gate on `DATABASE_URL` via `test/require-db.ts` — without a database they
skip, so `npm test` stays usable on a laptop with no Postgres running. **That is also a
trap:** a skipped tier still exits 0, so a green `npm test` can mean 48 of 113 tests never
ran. Any context that intends full coverage must say so with `ADP_REQUIRE_DB=1`, which turns
a missing `DATABASE_URL` into a hard collection failure instead of a silent skip. CI sets it
unconditionally. See `docs/test-environment-automation.md`.

**CI** (`.github/workflows/ci.yml`) runs on every push to `main` and every PR: typecheck,
build, migrate against a fresh Postgres service container, then the full test suite
including e2e. This is what actually validates the M0 exit criterion going forward, instead
of a one-off manual check.

**What this doesn't cover yet**, per the verification plan in `docs/pragmatic_mvp.md` Part
5: the `gh` record-replay conformance suite and the wider git fidelity suite (shallow /
partial / force-push / large file) are M1b+ work, once there's a GraphQL surface and more
git operations worth pinning against real GitHub behavior. The `conformance/` black-box
OpenAPI suite is the same — it needs a REST surface bigger than repo-create to be worth
writing.
