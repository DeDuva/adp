# dc-runtime

The client runtime behind the interactive essay at [`/why/`](../docs/html/why/index.html).
It compiles the `<x-dc>` template in that page — `{{ holes }}`, `<sc-for>`, `<sc-if>`,
`onClick` bindings — into React elements, and drives the twenty-three sliders, buttons and
animated sequences the essay argues with.

Building it writes three files, all committed:

| Output | What it is |
|---|---|
| `docs/html/support.js` | the runtime, bundled from `src/*.ts` |
| `docs/html/vendor/react-18.3.1.production.min.js` | vendored verbatim from the pinned `react` dependency |
| `docs/html/vendor/react-dom-18.3.1.production.min.js` | vendored verbatim from the pinned `react-dom` dependency |

```bash
make dc-runtime          # install, typecheck, and assert the committed outputs are current
npm run build            # regenerate them after changing src/
```

The outputs are committed because **the published site has no build step** — a constraint
carried over from #138, and the reason `pages.yml` can upload `docs/html/` wholesale. What
this package adds is not a pipeline in front of the site; it is the ability to *regenerate*
what the site already serves. `npm run check` rebuilds into memory and compares, so a
hand-edited artifact or an uncommitted source change fails CI (`site-runtime`) rather than
shipping.

## Where the source came from

This package was reconstructed, in #163, from `docs/html/support.js` itself.

That file arrived generated, and its own header named a `dc-runtime/` that had never been
in this repository. It could be served but not rebuilt, fixed, or upgraded by anyone
working here — #138 saw that, confined it to the secondary page, and left the decision
open. The decision taken was to vendor.

The recovery was mechanical rather than interpretive, because the artifact was an
unminified `esbuild` bundle that had kept its `// src/*.ts` markers, its identifier names
and its comments. Splitting it at those markers gave eighteen modules with no top-level
name collisions and an acyclic import graph, which the bundle's own module order confirms.
Restoring the `import`/`export` edges, the TypeScript class fields that `esbuild` had
lowered to `__publicField`, and two `as` casts it had erased to bare parentheses was enough
to rebuild it.

**The reconstruction is verified by rebuilding it.** A fresh build reproduces the
previously committed `support.js` byte for byte, with exactly two classes of exception:

- the banner, changed deliberately to name a command this repository actually has;
- two pairs of redundant parentheses, around the `h` and `render` arrow functions.

The parentheses are the fingerprint of the original toolchain. The old banner said
`bun run build`, and `bun`'s printer keeps redundant grouping where `esbuild`'s drops it.
Reproducing them would mean requiring `bun` for a repository that is otherwise Node 22 and
npm (`.nvmrc`), which trades a real dependency for a cosmetic diff. The build uses
`esbuild`, and the two paren pairs are the whole cost.

## What changed from the original, and why

**React is no longer fetched from a CDN.** The runtime used to load React, ReactDOM and
`@babel/standalone` from `unpkg.com` on every page load, pinned by SRI. That meant the
published site depended on a third party at read time — and because the runtime hides the
raw `<x-dc>` template before loading anything, an unreachable unpkg produced a *blank
page*, not a degraded one. It also put two packages on the site that this repository did
not contain, which is the same defect as the missing source, one layer out.

The React bundles are now vendored beside `support.js` by this build, from the pinned
dependencies. They are the same bytes: `react@18.3.1` and `react-dom@18.3.1` as installed
from npm hash to the exact `sha384` SRI values the old `src/cdn.ts` pinned for unpkg, so
the browser executes what it executed before and only the origin changed. `src/assets.ts`
resolves them against **this script's** own URL rather than the document's, which is what
lets one `support.js` serve both `/` and `/why/`.

`@babel/standalone` is *not* vendored. It is 2.8 MB, it was only ever reached by
`<x-import>` of JSX, and nothing on the site uses that path — both pages contain zero
`x-import` elements. `ensureBabel()` now rejects with an explanation instead of reaching
for the network; a host page that supplies `window.Babel` still works.

Google Fonts is once again the only external asset either page loads.

## Layout

| Path | |
|---|---|
| `src/index.ts` | entry: loads React, installs the `window.__dc*` bridge, boots |
| `src/parse.ts`, `src/encode.ts`, `src/compile.ts` | `<x-dc>` document → encoded template → React builders |
| `src/expr.ts` | `{{ dotted.path }}` resolution — lookups only, never expressions |
| `src/logic.ts`, `src/component.ts` | the `DCLogic` base class and its React wrapper |
| `src/runtime.ts`, `src/registry.ts` | component registry, hot update, streaming state |
| `src/helmet.ts`, `src/pseudo.ts`, `src/atomics.ts` | `<helmet>` styles, pseudo-class sheet, atomic CSS |
| `src/external.ts`, `src/bundled.ts` | `<x-import>` module loading and host-supplied blobs |
| `src/assets.ts` | where the vendored React bundles live |
| `src/globals.d.ts` | the `window` shapes this runtime relies on |

`src/globals.d.ts` exists because the runtime reaches React through UMD globals rather than
importing it, and the UMD global types shipped by `@types/react` model a module import and
contradict that. Those packages are deliberately not dependencies here.

## Typing

`tsconfig.json` is not strict. The source was recovered from erased output, so the original
type annotations are gone and inventing them would be inventing intent — the checked-in
types are the ones the code demonstrably requires (`useDefineForClassFields: true` is
load-bearing: it is what lowers class fields the way the published artifact does). Tighten
them when touching a module for a real reason, not as a sweep.
