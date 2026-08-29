/**
 * Builds the published runtime: `docs/html/support.js`, plus the React bundles
 * it loads, into `docs/html/vendor/`.
 *
 * `--check` rebuilds into memory and asserts every published file already
 * matches, so a stale artifact fails CI instead of shipping. The published
 * site has no build step of its own — these outputs are committed, and this
 * script is what proves the repository can still produce them.
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, '../docs/html');
const VENDOR_DIR = resolve(OUT_DIR, 'vendor');

const BANNER = [
  '// GENERATED from dc-runtime/src/*.ts — do not edit.',
  '// Rebuild with `make dc-runtime` (or `npm run build --prefix dc-runtime`).',
  '"use strict";',
].join('\n');

// Vendored verbatim from the pinned dependencies. The names carry the version
// so an upgrade is visible in the diff rather than hidden inside a file.
const VENDORED = [
  ['react/umd/react.production.min.js', 'react-18.3.1.production.min.js'],
  ['react-dom/umd/react-dom.production.min.js', 'react-dom-18.3.1.production.min.js'],
];

const result = await build({
  absWorkingDir: here,
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  write: false,
  banner: { js: BANNER },
  legalComments: 'inline',
});

/** @type {Array<[string, Buffer|string]>} path -> contents */
const artifacts = [[resolve(OUT_DIR, 'support.js'), result.outputFiles[0].text]];
for (const [from, to] of VENDORED) {
  const src = resolve(here, 'node_modules', from);
  if (!existsSync(src)) {
    console.error(`missing ${from} — run \`npm install --prefix dc-runtime\` first`);
    process.exit(1);
  }
  artifacts.push([resolve(VENDOR_DIR, to), readFileSync(src)]);
}

const rel = (p) => relative(resolve(here, '..'), p);

if (process.argv.includes('--check')) {
  const stale = [];
  for (const [path, want] of artifacts) {
    const have = existsSync(path) ? readFileSync(path) : null;
    if (have === null || !Buffer.from(want).equals(Buffer.from(have))) stale.push(rel(path));
  }
  if (stale.length) {
    console.error('stale or missing published artifacts:');
    for (const p of stale) console.error(`  ${p}`);
    console.error('run `make dc-runtime` and commit the result');
    process.exit(1);
  }
  console.log(`up to date: ${artifacts.map(([p]) => rel(p)).join(', ')}`);
  process.exit(0);
}

mkdirSync(VENDOR_DIR, { recursive: true });
for (const [path, contents] of artifacts) {
  writeFileSync(path, contents);
  console.log(`wrote ${rel(path)} (${Buffer.byteLength(contents)} bytes)`);
}
