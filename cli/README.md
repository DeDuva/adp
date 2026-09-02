# `adp` — the CLI

A thin command-line wrapper over ADP's REST endpoints, for scripting and CI steps that would
otherwise be a raw `curl` — plus `init`, `connect` and `disconnect`, which are not wrappers.

**The reference is the root [`README.md`](../README.md)**, under *`adp` CLI* and *`adp connect`*:
every command, what it wraps, and what `connect` writes where. This file is how to get it running,
which is the one thing that lives here because it is about this directory.

```bash
npm ci && npm run build
npm link                 # puts `adp` on your PATH
adp login --server https://adp.example.com --token <token>
```

`npm link` is the step the documentation used to skip. This package declares a `bin` and is
`private`, so it is never published to npm and `npm i -g @adp/cli` will not work — but every
example in the root README says `adp …`, so something has to bridge the two. Without the link,
spell it `node dist/index.js …` from this directory.

Undo it with `npm unlink -g @adp/cli`.

```bash
npm run typecheck && npm test    # or `make cli` from the repository root
```

No database and no server: the tests drive the argument parsing and the request shapes, and the
paths that touch a real instance are covered by `server/test/e2e-connect.test.ts`.
