/**
 * The published site's exit criteria (#163), asserted rather than eyeballed.
 *
 * These run against docs/html exactly as `pages.yml` uploads it, in the pinned
 * Chromium `make browser` installs. Every check here is one of the criteria the
 * issue names, and each replaces something that was previously only ever
 * checked by looking.
 */
import { test, expect } from '@playwright/test';
import { serveSite } from './serve.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/html');
const PAGES = ['/', '/why/', '/sdlc/'];
// The widths #163 names. 320 is the narrowest phone still worth supporting;
// 1440 is where the container stops growing.
const WIDTHS = [320, 375, 768, 1024, 1440];

let site;
test.beforeAll(async () => { site = await serveSite(ROOT); });
test.afterAll(async () => { await site?.close(); });

for (const path of PAGES) {
  for (const width of WIDTHS) {
    test(`${path} at ${width}px: no horizontal scroll on the body`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(site.base + path, { waitUntil: 'networkidle' });
      const { scrollWidth, clientWidth, widest } = await page.evaluate(() => {
        const de = document.documentElement;
        // Name the widest offender, so a failure says which element to fix.
        let widest = null, max = de.clientWidth;
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.right > max + 1) { max = r.right; widest = el.tagName + '.' + (el.className || '(none)'); }
        }
        return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, widest };
      });
      expect(scrollWidth, `widest overflowing element: ${widest}`).toBeLessThanOrEqual(clientWidth + 1);
    });
  }

  test(`${path}: renders, and only Google Fonts is off-origin`, async ({ page }) => {
    const offOrigin = [], errors = [], failed = [];
    page.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith(site.base) && !u.startsWith('data:')) offOrigin.push(u);
    });
    page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(site.base + path, { waitUntil: 'networkidle' });

    expect(errors, 'console / page errors').toEqual([]);
    expect(failed, 'failed requests').toEqual([]);
    // The whole point of vendoring in #166: nothing but fonts leaves the origin.
    const thirdParty = offOrigin.filter((u) => !/^https:\/\/fonts\.g(oogleapis|static)\.com\//.test(u));
    expect(thirdParty, 'third-party requests').toEqual([]);
    // The essay is compiled by the runtime; an un-replaced <x-dc> means it never booted.
    expect(await page.locator('x-dc').count(), 'un-booted <x-dc>').toBe(0);
    expect((await page.locator('h1').first().innerText()).trim().length).toBeGreaterThan(10);
  });

  test(`${path}: every table is readable at 375px`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto(site.base + path, { waitUntil: 'networkidle' });
    const tables = page.locator('table');
    for (let i = 0; i < (await tables.count()); i++) {
      const t = tables.nth(i);
      const box = await t.boundingBox();
      // No pinch-zoom: the table fits the viewport rather than spilling out of it.
      expect(box.width, `table ${i} width`).toBeLessThanOrEqual(375);
      // And its text is not shrunk below the readable floor to achieve that.
      const size = await t.locator('td').first().evaluate(
        (el) => parseFloat(getComputedStyle(el).fontSize));
      expect(size, `table ${i} font-size`).toBeGreaterThanOrEqual(13);
    }
  });

  test(`${path}: focus is visible on every interactive element`, async ({ page }) => {
    await page.goto(site.base + path, { waitUntil: 'networkidle' });
    // Tabbing is the only honest way to check this: `:focus-visible` cannot be
    // queried through getComputedStyle (it takes pseudo-elements, not
    // pseudo-classes), and programmatic .focus() does not always trigger it.
    // So walk the real keyboard path and read the ring off the focused element.
    let checked = 0;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const el = await page.evaluate(() => {
        const a = document.activeElement;
        if (!a || a === document.body || a === document.documentElement) return null;
        const s = getComputedStyle(a);
        return {
          what: a.tagName.toLowerCase() + (a.className ? '.' + String(a.className).split(' ')[0] : ''),
          style: s.outlineStyle,
          width: parseFloat(s.outlineWidth) || 0,
        };
      });
      if (!el) break;
      expect(el.style, `${el.what} outline-style`).not.toBe('none');
      expect(el.width, `${el.what} outline-width`).toBeGreaterThan(0);
      checked++;
    }
    expect(checked, 'focusable elements walked').toBeGreaterThan(2);
  });
}

// A botched block move once left `.argcard` nested inside `.argcard`, with one
// card's prose under another card's heading. It shipped: browsers repair bad
// nesting silently, every rendering assertion above still passed, and the page
// was visibly wrong. Self-nesting is never intended in this design system, and
// it is the signature of exactly that edit — so it is worth one cheap check.
for (const path of PAGES) {
  test(`${path}: no card-like element nests inside itself`, async ({ page }) => {
    await page.goto(site.base + path, { waitUntil: 'networkidle' });
    const nested = await page.evaluate(() =>
      ['argcard', 'card', 'step', 'stat', 'plate', 'grid']
        .map((c) => [c, document.querySelectorAll(`.${c} .${c}`).length])
        .filter(([, n]) => n > 0));
    expect(nested, 'self-nested elements').toEqual([]);
  });
}

// Tag balance is a separate failure from the above — the missing close does not
// self-nest anything, and the browser hides it just as thoroughly.
test('every page balances its divs', () => {
  for (const rel of ['index.html', 'why/index.html', 'sdlc/index.html']) {
    const src = readFileSync(resolve(ROOT, rel), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const open = (src.match(/<div\b/g) || []).length;
    const close = (src.match(/<\/div>/g) || []).length;
    expect(close, `${rel} div balance`).toBe(open);
  }
});

test('no page defines a colour, and no static inline style survives', () => {
  for (const rel of ['index.html', 'why/index.html', 'sdlc/index.html']) {
    const src = readFileSync(resolve(ROOT, rel), 'utf8');
    const body = src.replace(/<!--[\s\S]*?-->/g, '');

    // Criterion 1: one stylesheet owns the palette.
    // A colour is a hex used as a declaration value (`color:#abc`) or standing
    // alone as a string the logic hands to the runtime (`"#abc"`) — not a `#418`
    // that happens to be an issue number in the prose.
    const colours = [
      ...body.matchAll(/:\s*(#[0-9a-fA-F]{3,8})\b/g),
      ...body.matchAll(/["'](#[0-9a-fA-F]{3,8})["']/g),
      ...body.matchAll(/(\brgba?\([^)]*\))/g),
    ].map((m) => m[1]);
    expect(colours, `${rel} declares colours of its own`).toEqual([]);

    // Criterion 2, in the only form it can hold: presentational inline styles
    // are gone. What remains in the essay is state — a width or an opacity a
    // simulation computes per frame — which is data, not styling, and cannot
    // live in a stylesheet. Each is required to be a {{ hole }}.
    const inline = [...body.matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1]);
    const stat = inline.filter((v) => !v.includes('{{'));
    expect(stat, `${rel} has static inline style=`).toEqual([]);
  }
});

// ─────────────────────────────────────────────────────────────── #273 ──
// What a link to the site looks like when it is pasted somewhere. Until this
// existed, every share of any of the three pages unfurled as bare text: no
// card, no image, no icon, no canonical URL.
const SITE = 'https://deduva.github.io/adp/';
const SHARE = [
  { rel: 'index.html', at: '', up: './' },
  { rel: 'why/index.html', at: 'why/', up: '../' },
  { rel: 'sdlc/index.html', at: 'sdlc/', up: '../' },
];

test('every page carries its share metadata, in the static head', () => {
  for (const { rel, at, up } of SHARE) {
    const src = readFileSync(resolve(ROOT, rel), 'utf8');
    // The *static* head, deliberately — not the DOM, and not the rest of the
    // file. /why/ is compiled by the runtime from a template with its own
    // <helmet>, and metadata put there is invisible to every scraper on earth,
    // because none of them run JavaScript. That is exactly where this block
    // first landed, and the page looked perfect in a browser afterwards.
    const head = src.slice(src.indexOf('<head>'), src.indexOf('</head>'));
    const canon = SITE + at;
    const img = SITE + at + 'og.png';

    expect(head, `${rel} canonical`).toContain(`<link rel="canonical" href="${canon}">`);
    expect(head, `${rel} favicon`).toContain(`href="${up}favicon.svg"`);
    expect(head, `${rel} apple-touch-icon`).toContain(`href="${up}apple-touch-icon.png"`);
    expect(head, `${rel} og:url`).toContain(`content="${canon}"`);
    // Absolute, because a scraper does not resolve a relative og:image against
    // the page it found it on — it just drops the card.
    expect(head, `${rel} og:image`).toContain(`<meta property="og:image" content="${img}">`);
    expect(head, `${rel} twitter:image`).toContain(`<meta name="twitter:image" content="${img}">`);
    expect(head, `${rel} twitter:card`).toContain('content="summary_large_image"');

    for (const tag of ['og:type', 'og:site_name', 'og:title', 'og:description',
                       'og:image:alt', 'twitter:title', 'twitter:description']) {
      expect(head, `${rel} is missing ${tag}`).toContain(`"${tag}"`);
    }

    // And nothing below </head> declares any of it, which is the drift the
    // paragraph above describes. Matched as the attribute rather than as the
    // bare prefix: the essay's own prose says "op log:", which contains it.
    const below = src.slice(src.indexOf('</head>'));
    expect([...below.matchAll(/(?:property|name)="(og:[\w:]+|twitter:[\w:]+)"/g)].map((m) => m[1]),
      `${rel} declares share metadata outside <head>`).toEqual([]);
  }
});

test('the share cards are the size every platform crops to', () => {
  // A PNG's IHDR is fixed-offset: 8-byte signature, 4-byte length, "IHDR",
  // then width and height as big-endian uint32s.
  const png = (rel) => {
    const buf = readFileSync(resolve(ROOT, rel));
    expect(buf.subarray(0, 8).toString('latin1'), `${rel} is not a PNG`).toBe('\x89PNG\r\n\x1a\n');
    return { buf, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  };

  for (const { at } of SHARE) {
    const rel = at + 'og.png';
    const { buf, width, height } = png(rel);
    expect([width, height], `${rel} dimensions`).toEqual([1200, 630]);
    // Not a byte comparison — dc-runtime/og/render.mjs explains why a
    // screenshot cannot have one. A cap catches the thing that actually goes
    // wrong: a card that grew until platforms stopped fetching it.
    expect(buf.length, `${rel} bytes`).toBeLessThan(500_000);
  }

  const icon = png('apple-touch-icon.png');
  expect([icon.width, icon.height], 'apple-touch-icon dimensions').toEqual([180, 180]);
});

for (const { at, up } of SHARE) {
  test(`/${at}: every share asset it names actually resolves`, async ({ page, request }) => {
    await page.goto(site.base + '/' + at, { waitUntil: 'networkidle' });
    const urls = await page.evaluate(() => [
      ...[...document.querySelectorAll('link[rel="canonical"], link[rel="icon"], link[rel="apple-touch-icon"]')].map((l) => l.getAttribute('href')),
      ...[...document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]')].map((m) => m.getAttribute('content')),
    ]);
    expect(urls.length, 'share assets declared').toBe(5);
    for (const url of urls) {
      // The published origin is not reachable from a test run, so map it onto
      // the copy of docs/html this suite is already serving. A 404 here is a
      // path typo, which is the failure this catches — the card renders as
      // nothing and the page still looks fine.
      const local = url.startsWith(SITE)
        ? site.base + '/' + url.slice(SITE.length)
        : new URL(url, site.base + '/' + at).href;
      const res = await request.get(local);
      expect(res.status(), `${url} → ${local}`).toBeLessThan(400);
    }
  });
}
