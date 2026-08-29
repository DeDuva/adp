/**
 * Where the runtime's own assets live.
 *
 * This module used to name unpkg.com: React, ReactDOM and @babel/standalone
 * were fetched from a CDN on every page load, pinned by SRI. That made the
 * published site depend on a third party at read time — a blank page whenever
 * unpkg was unreachable — and put two packages on the page that this repository
 * did not contain. The bundles are now vendored next to `support.js` by the
 * build (`dc-runtime/build.mjs`), from the pinned `react` and `react-dom`
 * dependencies, and are byte-identical to what the CDN served.
 *
 * URLs resolve against **this script's** own location rather than the
 * document's, which is what lets one `support.js` serve both `/` and `/why/`.
 */

/** Kept in step with the directory and filenames `build.mjs` writes. */
export const VENDOR_DIR = "vendor";

const SCRIPT_SRC = (document.currentScript as HTMLScriptElement | null)?.src || '';

function assetUrl(file: string): string {
  try {
    return new URL(VENDOR_DIR + "/" + file, SCRIPT_SRC || document.baseURI).href;
  } catch {
    return VENDOR_DIR + "/" + file;
  }
}

export const REACT_URL = assetUrl("react-18.3.1.production.min.js");
export const REACT_DOM_URL = assetUrl("react-dom-18.3.1.production.min.js");

/**
 * A host editor may hand us a blob URL for a source it already holds, keyed by
 * the original URL. Nothing else rewrites; there is no integrity attribute to
 * carry any more, because everything the runtime loads is now same-origin.
 */
export function assetScriptFor(url: string): { src: string } {
  const res = window.__resources;
  const v = res ? res[url] : void 0;
  return typeof v === "string" && v ? { src: v } : { src: url };
}
