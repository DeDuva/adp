import { BASE_CSS, boot } from './boot.js';
import { createRuntime } from './runtime.js';
import { createStreamTracker } from './stream-state.js';
import { REACT_DOM_URL, REACT_URL, assetScriptFor } from './assets.js';

function hideRawTemplate() {
  const s = document.createElement("style");
  s.textContent = "x-dc{display:none!important}";
  document.head.appendChild(s);
}
function loadScript(src) {
  return new Promise<void>((resolve, reject) => {
    //! nosemgrep: create-script-element
    const s = document.createElement("script");
    s.src = src;
    // Same-origin now that the bundles are vendored, so there is no integrity
    // attribute and no crossOrigin to set.
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}
function loadReactUmd() {
  const w = window;
  if (w.React && w.ReactDOM) return Promise.resolve();
  return Promise.all([
    loadScript(assetScriptFor(REACT_URL).src),
    loadScript(assetScriptFor(REACT_DOM_URL).src)
  ]).then(() => void 0);
}
function init() {
  const runtime = createRuntime(document);
  let rootName = "Root";
  const baseCss = document.createElement("style");
  baseCss.textContent = BASE_CSS;
  document.head.prepend(baseCss);
  const notifyHost = () => {
    if (window.parent === window) return;
    const r = runtime.registry.entries[rootName];
    try {
      window.parent.postMessage(
        {
          type: "__dc_booted",
          rootName,
          propsMeta: r && r.propsMeta || null,
          preview: r && r.preview || null
        },
        "*"
      );
    } catch {
    }
  };
  const streams = createStreamTracker();
  const api = {
    __dcUpdate: (name, kind, content, streaming, viewportKey) => {
      streams.push(name, streaming, viewportKey);
      runtime.dcUpdate(name, kind, content, streaming);
      if (name === rootName && !streaming && kind === "props") notifyHost();
    },
    __dcStreaming: (name) => streams.live(name),
    __dcSetProps: (name, overrides) => runtime.setProps(name, overrides),
    /** Name of the component currently mounted as the page root — DC tools
     *  push their template-stream here when targeting "the open page". */
    __dcRootName: () => rootName,
    /** Editor bridge — the encoded, `data-dc-tpl`-annotated template source.
     *  The host editor parses this into its own template DOM so it can map a
     *  rendered node (carrying the same `data-dc-tpl`) back to the source
     *  node that emitted it. Returns the encoded form (`sc-camel-*` attrs,
     *  `<sc-raw-*>`/`<sc-helmet>` tags); the editor decodes on serialize. */
    __dcAnnotatedTemplate: (name) => runtime.annotatedTemplate(name),
    /** Editor bridge — the *original* (decoded) template source. */
    __dcTemplateSource: (name) => runtime.templateSource(name),
    __dcBoot: () => {
      rootName = boot(runtime, document) ?? rootName;
      notifyHost();
    },
    __dcRegistry: runtime.registry.entries,
    getDC: (name) => runtime.getDC(name),
    // `DCLogic` is the documented base class name; `StreamableLogic` is the
    // implementation alias kept for any project that already references it.
    DCLogic: runtime.StreamableLogic,
    StreamableLogic: runtime.StreamableLogic
  };
  Object.assign(window, api);
  window.__dcContentKeyed = true;
  if (document.readyState !== "loading") api.__dcBoot();
  else document.addEventListener("DOMContentLoaded", () => api.__dcBoot());
}
hideRawTemplate();
loadReactUmd().then(init).catch((err) => {
  console.error("[dc] failed to load React or boot:", err);
  throw err;
});
