/**
 * Renders the site's share cards and the apple-touch icon into docs/html/.
 *
 *   node og/render.mjs        # from dc-runtime/, or `make og` from the root
 *
 * docs/html/ is deployed straight from the tree with no build step (#138), so
 * these PNGs are build outputs that ship as inputs — the same arrangement as
 * support.js and vendor/*. The difference is what can be asserted about them.
 * support.js is checked byte-for-byte because esbuild is deterministic; a
 * screenshot is not. Chromium's glyph rasterisation moves with the browser
 * version, and the faces themselves are fetched from Google Fonts at render
 * time, so a byte comparison here would fail on a Playwright bump rather than
 * on a change anyone made. The check that is worth having instead lives in
 * test/site.test.mjs: the files exist, they are PNGs, they are exactly the
 * dimensions the platforms crop to, and they are small enough to unfurl.
 *
 * What this file buys is the thing the byte check was only ever a proxy for —
 * the image is regenerable by anyone who clones the repo, from a source
 * (card.html) that is committed and readable.
 */
import { chromium } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../../docs/html');

// One card per page, so a link to /why/ unfurls as /why/ rather than as the
// front page. The text is the page's own — its h1's argument and a line from
// its lede — rather than a second, drifting description of it. The eyebrow is
// the label the masthead nav already gives that page, which is why it does not
// simply repeat the band above it.
const CARDS = [
  {
    file: 'og.png',
    eyebrow: 'Overview',
    title: 'Agents write the code. Someone still has to answer for it.',
    sub: 'A self-hosted, GitHub-compatible forge that binds every change to its intent, provenance, approvals and signed evidence.',
    foot: 'deduva.github.io/adp',
  },
  {
    file: 'why/og.png',
    eyebrow: 'Why ADP exists',
    title: 'Code got cheap. Trust didn’t.',
    sub: 'An agent saying “tests pass” is a belief. This is the argument for turning it into evidence, with simulations and a landscape analysis.',
    foot: 'deduva.github.io/adp/why/',
  },
  {
    file: 'sdlc/og.png',
    eyebrow: 'The AI-native SDLC',
    title: 'Six stages, six artifacts. What enforces them?',
    sub: 'The playbooks agree on the shape and stop at the handoff. This walks all six stages and asks what holds each one when nobody reads every line.',
    foot: 'deduva.github.io/adp/sdlc/',
  },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(resolve(HERE, 'card.html')).href, { waitUntil: 'networkidle' });

for (const card of CARDS) {
  await page.evaluate((c) => {
    for (const key of ['eyebrow', 'title', 'sub', 'foot']) document.getElementById(key).textContent = c[key];
  }, card);
  // The faces are webfonts: screenshotting before they land renders the card in
  // the fallback stack, which looks almost right and is wrong.
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.og').screenshot({ path: resolve(OUT, card.file) });
  console.log('wrote docs/html/' + card.file);
}

// The apple-touch icon, from the same source as the favicon so the two cannot
// drift. iOS ignores rel="icon" SVGs and falls back to a screenshot without it.
const icon = await browser.newPage({ viewport: { width: 180, height: 180 }, deviceScaleFactor: 1 });
await icon.goto(pathToFileURL(resolve(OUT, 'favicon.svg')).href, { waitUntil: 'load' });
await icon.screenshot({ path: resolve(OUT, 'apple-touch-icon.png') });
console.log('wrote docs/html/apple-touch-icon.png');

await browser.close();
