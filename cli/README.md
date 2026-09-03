# `adp`

The command-line client for [ADP](https://github.com/DeDuva/adp) — the agent-native forge.

```bash
npx @deduva/adp --help          # no install
npm install -g @deduva/adp      # or put `adp` on your PATH
```

Node 22 or newer. No runtime dependencies: the install is one download and no tree.

## What it is for

ADP records every change as a signed transaction binding **intent → diff → evidence →
provenance**. This CLI is how a person or an agent reaches the parts of that GitHub has no
analogue for — the operation log, `undo`, evidence bundles — and how a repository that already
exists gets connected to an instance in the first place.

```bash
adp login --server https://adp.example.com   # store a token for this machine
adp init                                     # org, repo, mirror and a detected adp.yaml
adp connect claude-code                      # write a harness's own configuration, and prove it
adp pr list
adp watch <sha>                              # the land verdict, without attempting the merge
adp undo <sha>                               # resolve a commit to its merge and take it back out
```

`adp init` is additive by default: a checkout with an upstream is **mirrored** rather than moved,
so your remote, your pull requests and your CI do not change and the ADP record fills anyway.

## Where the documentation is

The [repository README](https://github.com/DeDuva/adp#readme) is the reference for every command,
the contract the CLI speaks (`spec/openapi.yaml`), and how to self-host an instance to point it at.

MIT.
