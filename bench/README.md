# `bench/` — the ADP benchmark harness

The D4 demo and the A1 study (`docs/adp-prototype-implementation-plan.md` §5, §8).
Zero runtime dependencies, same as `adapters/`.

Per A1 this benchmark **gates our own investment**, and per §8 the value is in
running it transparently. So: results are published whichever way they point, and
arms that were not run are reported as not run rather than omitted.

## The arms, and which are trustworthy without a caveat

The single most important thing about this harness is that its arms are not all
the same kind of measurement, and the report says so on every page.

| Arm | Needs a model? | Runs in CI? | Status |
|---|---|---|---|
| **1 — merge contention** | No | **Yes**, at small N | ✅ Run; see [`report/merge-contention.md`](report/merge-contention.md) |
| **2 — three-way cost comparison** (GitHub+`gh` vs ADP-MCP vs ADP-via-`gh`) | Yes | No | ⬜ Not run |
| **3 — fan-out vs serial** | Yes | No | ⬜ Not run |

**Arm 1 is deterministic.** No agent, no LLM call, no tokens spent. It measures
ADP's land path under contention, which is a property of the server, not of an
agent's ability to drive it. That makes it cheap enough to enforce on every
change — `server/test/e2e-merge-contention.test.ts` drives *this exact module*,
not a reimplementation of it, so the code CI checks is the code that produced the
published numbers.

**Arms 2 and 3 are agent-backed and are not run here.** They need a real agent
burning real tokens and, for the GitHub arm, a real GitHub repository and PAT.
Nothing in CI can run them, and pretending otherwise by substituting a scripted
stand-in for an agent would produce numbers that look like arm 1's but mean
something entirely different. When they are run, their records go in `runs/` like
everything else, and their report must give a spread across repeats rather than a
single figure — they are stochastic, and a single number from a stochastic
process is not a result.

## The reproducibility contract

1. Every run writes a machine-readable record to `runs/`, committed: the arm, its
   configuration, the raw per-writer measurements, the server commit, and the
   environment.
2. `report/build-report.mjs` derives **every published number** from those
   records. If a number is not in a record, the script cannot produce it.
3. A reader re-derives the report with `npm run report` — no agent, no server, no
   trust required in the figures having been transcribed correctly.
4. Re-running from scratch needs a server; see below.

## Running arm 1

```bash
# Against any ADP instance you have a token for.
ADP_SERVER_URL=http://127.0.0.1:3000 \
ADP_TOKEN=adp_pat_... \
ADP_SERVER_COMMIT=$(git rev-parse HEAD) \
  node arms/merge-contention.mjs --owner myorg --repo myrepo --writers 8 \
    --out runs/merge-contention-w8.json

npm run report   # regenerate report/merge-contention.md from runs/
```

The target repo needs a `main` with at least one commit. The driver creates
everything else it needs (blobs, trees, commits, refs, proposals) over the REST
API — no clone, so clone cost never contaminates the land latency being measured.

A run where writers failed for reasons *other than* contention exits nonzero. A
broken run is not a result and must not be published as one.

## Reading the numbers honestly

Each report carries its own "what this does not show" section, and those sections
are not boilerplate — they are the part that keeps the benchmark honest. The
short version for arm 1: it is not a comparison against GitHub, the retry loop is
deliberately adversarial (no backoff, no jitter, simultaneous start), latency is
dominated by REST round-trips rather than git work, and the hardware is a dev
box. The *shape* of the curve is the finding. The constants are not.
