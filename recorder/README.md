# `adp-recorder` — the trajectory producer

Records what an agent actually did — every message, model call and tool call, in order and
hash-chained — by reading a stream the harness is *already* producing, from a separate process.
Nothing runs inside the agent's context window.

**The reference is the root [`README.md`](../README.md)**, under *`adp-recorder`*: the three
commands, the session lifecycle, which harnesses have readers, and what an uncovered harness still
gets.

```bash
npm ci && npm run build
npm link                 # puts `adp-recorder` on your PATH
export ADP_SERVER_URL=https://adp.example.com ADP_TOKEN=<token>
```

Needs only `repo:write` — the scope a developer's own token already carries — so it runs as the
developer rather than as infrastructure. `adp connect <harness>` writes a launcher that invokes it
for you; these steps are for running it by hand.

## Adding a harness

A reader translates one harness's private event names into ADP's fixed vocabulary, and lives in
[`src/readers/`](src/readers/index.ts) — a module exporting `createReader()` returning `read(line)`
and `end()`. It loads with `--reader ./my-reader.js` without this package changing, which is what
keeps `harness` a string the server never branches on.

```bash
npm run typecheck && npm test    # or `make recorder` from the repository root
```

No database and no Docker.
