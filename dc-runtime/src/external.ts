import { bundledBlob } from './bundled.js';
import { getReact } from './react.js';

const isCustomElementName = (n) => !n.includes(".") && n.includes("-");
function isRenderableType(g) {
  if (typeof g === "function") return !isElementClass(g);
  return typeof g === "object" && g !== null && typeof g.$$typeof === "symbol";
}
function resolveDottedPath(root, name) {
  let cur = root;
  for (const seg of name.split(".")) {
    if (cur == null) return void 0;
    cur = cur[seg];
  }
  return cur;
}
const GLOBAL_POLL_INTERVAL_MS = 50;
const GLOBAL_POLL_TIMEOUT_MS = 3e4;
export function createExternalModules(onResolved) {
  const cache = /* @__PURE__ */ new Map();
  const reportedMissing = /* @__PURE__ */ new Map();
  const polling = /* @__PURE__ */ new Set();
  // `@babel/standalone` is 2.8 MB and was fetched from unpkg on first JSX
  // `x-import`. Nothing on the published site uses that path, and pulling a
  // third-party megabyte at read time is exactly what this build set out to
  // stop — so JSX now needs a host that already supplies Babel, and says so
  // instead of reaching for the network.
  function ensureBabel() {
    if (window.Babel) return Promise.resolve();
    return Promise.reject(new Error(
      "dc-runtime: <x-import> of JSX needs window.Babel, which this build does " +
      "not ship. Import already-compiled JavaScript, or have the host page " +
      "provide @babel/standalone."
    ));
  }
  const pending = /* @__PURE__ */ new Map();
  function load(kind, url, after) {
    const existing = pending.get(url);
    if (existing) return existing;
    cache.set(url, null);
    console.info("[dc-runtime] x-import: loading", url, "(" + kind + ")");
    const ready = Promise.all([
      kind === "jsx" ? ensureBabel() : Promise.resolve(),
      after ?? Promise.resolve()
    ]);
    const p = ready.then(() => {
      const pre = bundledBlob(url);
      if (pre) return pre.text();
      return fetch(url).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      });
    }).then((src) => {
      const code = kind === "jsx" ? window.Babel.transform(src, {
        filename: url,
        presets: ["react", "typescript"]
      }).code : src;
      const module = { exports: {} };
      const before = new Set(Object.keys(window));
      //! nosemgrep: eval-and-function-constructor
      new Function("React", "module", "exports", "require", code)(
        getReact(),
        module,
        module.exports,
        () => ({})
      );
      const globals = {};
      for (const k of Object.keys(window)) {
        if (!before.has(k) && typeof window[k] === "function") {
          globals[k] = window[k];
        }
      }
      cache.set(url, { mod: module.exports, globals });
      console.info(
        "[dc-runtime] x-import: loaded",
        url,
        "\u2014 exports:",
        Object.keys(module.exports),
        "window globals:",
        Object.keys(globals)
      );
      onResolved();
    }).catch((e) => {
      cache.set(url, {
        mod: {},
        globals: {},
        error: "failed to load: " + (e instanceof Error && e.message ? e.message : String(e))
      });
      console.error(
        "[dc-runtime] x-import: FAILED to load",
        url,
        "(" + kind + ")",
        e
      );
      onResolved();
    });
    pending.set(url, p);
    return p;
  }
  function resolve(url, name) {
    const entry = cache.get(url);
    if (!entry) return null;
    const { mod, globals } = entry;
    const C = mod && mod[name] || globals && globals[name] || typeof window !== "undefined" && window[name] || mod && mod.default;
    if (typeof C === "function") return C;
    const key = url + "\0" + name;
    if (!reportedMissing.has(key)) {
      reportedMissing.set(
        key,
        entry.error || 'no export named "' + name + '" (has: ' + Object.keys(mod).join(", ") + ")"
      );
      console.error(
        "[dc-runtime] x-import: module",
        url,
        "loaded but has no component named",
        JSON.stringify(name),
        "\u2014 available exports:",
        Object.keys(mod),
        "window globals:",
        Object.keys(globals),
        ". The module must `module.exports = {" + name + "}` or set `window." + name + "`."
      );
    }
    return null;
  }
  function waitForGlobal(name) {
    if (polling.has(name)) return;
    polling.add(name);
    const started = Date.now();
    const isCE = isCustomElementName(name);
    const tick = () => {
      const found = isCE ? customElements.get(name) : isRenderableType(resolveDottedPath(window, name));
      if (found) {
        polling.delete(name);
        onResolved();
        return;
      }
      if (Date.now() - started >= GLOBAL_POLL_TIMEOUT_MS) {
        console.warn(
          "[dc-runtime] x-import: global",
          JSON.stringify(name),
          "never appeared on window after " + GLOBAL_POLL_TIMEOUT_MS + "ms"
        );
        return;
      }
      setTimeout(tick, GLOBAL_POLL_INTERVAL_MS);
    };
    setTimeout(tick, GLOBAL_POLL_INTERVAL_MS);
  }
  function resolveGlobal(url, name) {
    const isCE = isCustomElementName(name);
    if (!url) {
      if (isCE) {
        if (customElements.get(name)) return name;
        waitForGlobal(name);
        return null;
      }
      const g2 = resolveDottedPath(window, name);
      if (isRenderableType(g2)) return g2;
      waitForGlobal(name);
      return null;
    }
    const entry = cache.get(url);
    if (!entry) return null;
    if (isCE && customElements.get(name)) return name;
    const g = entry.globals[name] ?? resolveDottedPath(window, name);
    if (isRenderableType(g)) return g;
    if (name.includes(".")) return null;
    const key = url + "\0global\0" + name;
    if (!reportedMissing.has(key)) {
      reportedMissing.set(key, null);
      if (isCE && !customElements.get(name)) {
        console.warn(
          "[dc-runtime] x-import:",
          url,
          "loaded but no custom element",
          JSON.stringify(name),
          "is registered and window." + name + " is not a function \u2014 rendering <" + name + "> as an unknown element."
        );
      }
    }
    return name;
  }
  function getError(url, name) {
    const entry = cache.get(url);
    if (entry?.error) return entry.error;
    return reportedMissing.get(url + "\0" + name) || null;
  }
  return { load, resolve, resolveGlobal, getError };
}
function isElementClass(g) {
  try {
    return typeof g === "function" && typeof HTMLElement !== "undefined" && g.prototype instanceof HTMLElement;
  } catch {
    return false;
  }
}
