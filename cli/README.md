# `adp` — the CLI for the agent-native forge

```bash
npx @deduva/adp --help          # no install
npm install -g @deduva/adp      # or put `adp` on your PATH
```

Node 22 or newer. No runtime dependencies: the install is one download and no tree.

## What you have just installed

**[ADP](https://github.com/DeDuva/adp) is a self-hosted, GitHub-compatible forge for AI coding
agents.** It records every change as a signed transaction binding **intent → diff → evidence →
provenance**, and refuses to land a change that does not meet your evidence requirements — because
an agent saying "tests pass" is a belief, and the transcript that could show its work is gone when
the session ends.

**This package is the client, not the forge.** `adp` talks to an ADP *instance* — a server, holding
the repositories and the record — and does nothing at all without one. So the first question is
where yours is.

## Getting an instance

Three answers, in increasing order of commitment. All of them need Docker and Node 22.

**See what it does, then throw it away** — about a minute:

```bash
git clone https://github.com/DeDuva/adp.git && cd adp
make demo
```

An ephemeral instance, driven with ordinary `git` and an **unmodified `gh`**: clone, push, open a
proposal, report a gate, land the change. It ends where the point is — the merge is refused while
the change has no gate result and no approval, and allowed once it has both.

**Keep one on this machine**, from the same clone:

```bash
make local     # prints a URL and a token; then make local-down / make local-destroy
```

That is what to point this CLI at while you evaluate. Note that `adp` uses the plain **HTTP** port
it prints; `gh` is the tool that needs the certificate, because it refuses plain HTTP for any host
but github.com.

```bash
adp login --server http://localhost:8420 --token <the token make local printed>
```

**Run a real one** — the Helm chart or the Compose stack:
[`docs/self-hosting.md`](https://github.com/DeDuva/adp/blob/main/docs/self-hosting.md).

## Point it at a repository you already have

You do not move the repository. In **companion mode** it stays on GitHub, your remote and your pull
requests do not change, and ADP sits underneath recording what your issues, reviews and merges
mean — then publishes its verdict back onto the pull request as a check GitHub can require.

```bash
adp init --repo <org>/<repo> --credential <a GitHub token ADP can push with>
```

From inside your own checkout. It creates the repository on your instance, records which repository
this clone is, configures the mirror in both directions, and writes an `adp.yaml` detected from what
your repository already says about itself — showing it to you rather than committing it.

The whole of it, including what it deliberately refuses to do:
[`docs/companion-mode.md`](https://github.com/DeDuva/adp/blob/main/docs/companion-mode.md).

## The commands

```bash
adp login --server <url> --token <token>   # store a token for this machine
adp init                                   # org, repo, mirror and a detected adp.yaml
adp connect claude-code                    # write a harness's own configuration, and prove it
adp pr list --repo <owner>/<repo>
adp watch --repo <owner>/<repo>            # the land verdict, without attempting the merge
adp undo <sha> --repo <owner>/<repo>       # resolve a commit to its merge and take it back out
adp reimplement <sha>                      # the same intent, a second run, and the comparison
```

Most of these are thin wrappers over the REST plane at `/api/adp`, so behaviour is defined in one
place rather than per protocol. `adp connect` and `adp init` are not wrappers: they write into the
repository you are standing in.

`--help` on any of them, and on `adp` itself, is the reference that ships with the binary.

## Where the documentation is

| | |
|---|---|
| [Repository README](https://github.com/DeDuva/adp#readme) | Every command, both API planes, and the contract (`spec/openapi.yaml`) |
| [What ADP is](https://deduva.github.io/adp/) | The site, if you would rather read than run |
| [Companion mode](https://github.com/DeDuva/adp/blob/main/docs/companion-mode.md) | ADP underneath GitHub, end to end |
| [Self-hosting](https://github.com/DeDuva/adp/blob/main/docs/self-hosting.md) | Running the instance this points at |

MIT.
