# ADP server — M0 through M1c (most of it)

Fastify + PostgreSQL server. Working end to end: token-authenticated repo creation, git
smart-HTTP (clone/push) proxied to the real `git http-backend` binary, issues (which each
file an intent) with comments, typed changes (a git commit bound to an intent and a
server-signed provenance record), proposals (PR-shaped, opened against a head/base branch),
typed reviews, and merges under a two-level land policy (instance floor ∧ repo `adp.yaml`,
fast-forward only). GraphQL at `/api/graphql` is backed by GitHub's real, unmodified public
schema (`spec/graphql/github.graphql`) with both queries and mutations resolved.

**GraphQL scope, precisely:** `Query.repository`, `Query.node`, `Query.viewer`,
`Repository.{owner,defaultBranchRef,issue,issues,pullRequest,pullRequests}`,
`Issue.author`, `PullRequest.author` have resolvers, plus all 9 mutations
(`createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`, `closePullRequest`,
`reopenPullRequest`, `markPullRequestReadyForReview`, `addPullRequestReview`, `addComment`) —
enough to back `gh repo view`, `gh issue list/view/create/close`, `gh pr list/view/create/
merge/review` for real. **Validated against the real `gh` binary**: `conformance/run.sh`,
pinned to `gh` v2.63.0, drives the actual unmodified binary through
`issue create` → `issue view` → `pr create` → `pr view` → `pr merge` against a live server
in CI on every PR — see `docs/pragmatic_mvp.md` §M1b′ item 3 for what that gate does and
doesn't cover (it isn't record-replay against production github.com).

Real git `pre-receive`/`post-receive` hooks auto-record signed changes on every push and run
push protection against committed secrets (bundled regex+entropy scanner). Gate results
(`POST .../gates`) are stored as DSSE-signed in-toto evidence envelopes and rolled up into
`Commit.statusCheckRollup`. A native plane at `/api/adp` (op log and history query
filterable by actor/verb/date/path, undo of a landed fast-forward merge, workspaces,
evidence-bundle read, candidate sets) is wrapped by a real MCP server (`server/src/mcp/`,
8 tools) and by a read-only web UI (`server/web/`, served at `/ui/*`).

Proposal/issue numbering are independent sequences rather than GitHub's shared one — a
known fidelity gap.
Refresh the vendored GraphQL schema with `scripts/update-graphql-schema.sh`.
See `docs/pragmatic_mvp.md` for the milestone plan and status ledger.

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

## Testing

Three tiers, matching how much infrastructure each needs. All run under
[Vitest](https://vitest.dev); `npm test` runs the whole suite.

| Tier | Files | Needs | What it covers |
|---|---|---|---|
| Unit | `src/**/*.test.ts` (auth, config) | nothing | pure logic — token hashing, env validation |
| Integration | `src/**/*.test.ts` (git-backend, http-git proxy) | a real `git` binary (no DB) | bare repo creation, and a full `git clone`/`push` through Fastify into `git http-backend`, with auth stubbed to a fixed identity |
| End-to-end | `test/e2e.test.ts` | Postgres (`DATABASE_URL`) | the actual M0 exit criterion: mint a token, create a repo over REST, `git clone`/`push` with that token as the git password, confirm the commit landed |

```bash
npm test              # everything the current environment supports
npm run typecheck      # tsc --noEmit, including test files
```

The e2e suite uses `describe.skipIf(!process.env.DATABASE_URL)` — it's silently skipped
without a database (e.g. a laptop with no Postgres running) so `npm test` stays usable
everywhere, but it always runs in CI, which provides Postgres as a service container. If
you have a local Postgres, set `DATABASE_URL` before running `npm test` to exercise it too.

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
