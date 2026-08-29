import { getReact, getReactDOM, h } from './react.js';
import { dcNameFromPath, parseDcDocument, parseDcText } from './parse.js';

export const BASE_CSS = `
    .sc-placeholder{background:color-mix(in srgb,currentColor 8%,transparent);
      border:1px solid color-mix(in srgb,currentColor 50%,transparent);
      border-radius:2px;box-sizing:border-box;overflow:hidden}
    @keyframes sc-shine{0%{background-position:100% 50%}100%{background-position:0% 50%}}
    html.sc-dc-streaming .sc-placeholder,
    html.sc-dc-streaming .sc-interp.sc-missing{position:relative;
      background:color-mix(in srgb,currentColor 5%,transparent);
      border-color:transparent}
    html.sc-dc-streaming .sc-placeholder::before,
    html.sc-dc-streaming .sc-interp.sc-missing::before{content:'';
      position:absolute;inset:0;pointer-events:none;
      background:linear-gradient(90deg,rgba(217,119,87,0) 25%,rgba(247,225,211,.95) 37%,rgba(217,119,87,0) 63%);
      background-size:400% 100%;animation:sc-shine 1.4s ease infinite}
    html.sc-dc-streaming .sc-placeholder:nth-child(n+9 of .sc-placeholder)::before,
    html.sc-dc-streaming .sc-interp.sc-missing:nth-child(n+9 of .sc-interp.sc-missing)::before{animation:none;
      background:color-mix(in srgb,currentColor 8%,transparent)}
    .sc-placeholder-error{padding:4px 8px;font:11px/1.4 ui-monospace,monospace;
      color:color-mix(in srgb,currentColor 70%,transparent);word-break:break-word}
    .sc-interp.sc-missing{display:inline-block;width:2em;height:1em;overflow:hidden;
      vertical-align:text-bottom;background:rgba(255,255,255,.3);border:1px solid rgba(0,0,0,.5);
      border-radius:2px;box-sizing:border-box;color:transparent;
      user-select:none}
    .sc-interp.sc-unresolved{font-family:ui-monospace,monospace;font-size:.85em;
      color:color-mix(in srgb,currentColor 50%,transparent);
      background:color-mix(in srgb,currentColor 10%,transparent);border-radius:3px;
      padding:0 3px}
    .sc-host.sc-has-error{position:relative}
    .sc-logic-error{position:absolute;top:8px;left:8px;z-index:2147483647;max-width:60ch;
      padding:6px 10px;background:#b00020;color:#fff;font:12px/1.4 ui-monospace,monospace;
      border-radius:4px;white-space:pre-wrap;pointer-events:none}
    /* Mirrors PRINT_BASELINE_CSS in apps/web deck-stage-export.ts \u2014 keep both
       in sync until dc-runtime regains a build step. */
    @media print {
      @page { margin: 0.5cm; }
      figure, table { break-inside: avoid; }
      #dc-root, #dc-root > .sc-host { height: auto; }
      *, *::before, *::after {
        print-color-adjust: exact; -webkit-print-color-adjust: exact;
        backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
        animation-delay: -99s !important; animation-duration: .001s !important;
        animation-iteration-count: 1 !important; animation-fill-mode: both !important;
        animation-play-state: running !important; transition-duration: 0s !important;
      }
    }
  `;
const FULL_PAGE_CSS = "html,body{height:100%;margin:0}#dc-root,#dc-root>.sc-host{height:100%}";
function rootNameForDocument(doc, loc) {
  let bootPath = loc.pathname || "";
  if (!/\.dc\.html?$/i.test(safeDecode(bootPath))) {
    try {
      bootPath = new URL(doc.baseURI || "/").pathname;
    } catch {
    }
  }
  return dcNameFromPath(bootPath);
}
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
export function boot(runtime, doc = document) {
  const parsed = parseDcDocument(doc);
  if (!parsed) return null;
  const React = getReact();
  const rootName = rootNameForDocument(doc, location);
  runtime.markFetched(rootName);
  runtime.setRootName(rootName);
  runtime.adoptParsed(rootName, parsed);
  if (!window.__resources) {
    fetch(location.href).then((res) => res.ok ? res.text() : "").then((t) => {
      const raw = t ? parseDcText(t) : null;
      if (raw?.template) runtime.updateHtml(rootName, raw.template);
    }).catch(() => {
    });
  }
  const dc = doc.querySelector("x-dc");
  const hostEl = doc.createElement("div");
  hostEl.id = "dc-root";
  dc.replaceWith(hostEl);
  if (!parsed.preview) {
    const s = doc.createElement("style");
    s.textContent = FULL_PAGE_CSS;
    doc.head.appendChild(s);
  }
  const Root = runtime.getDC(rootName);
  const entry = runtime.registry.get(rootName);
  function StandaloneRoot() {
    const [, setTick] = React.useState(0);
    React.useEffect(() => {
      const sub = () => setTick((n) => n + 1);
      entry.subs.add(sub);
      return () => {
        entry.subs.delete(sub);
      };
    }, []);
    const defaults = React.useMemo(() => {
      const d = {};
      for (const k in entry.propsMeta || {}) {
        const v = entry.propsMeta?.[k]?.default;
        if (v !== void 0) d[k] = v;
      }
      return d;
    }, [entry.propsMeta]);
    return h(Root, { ...defaults, ...entry.propOverrides || {} });
  }
  const ReactDOM = getReactDOM();
  if (ReactDOM.createRoot)
    ReactDOM.createRoot(hostEl).render(h(StandaloneRoot));
  else ReactDOM.render(h(StandaloneRoot), hostEl);
  return rootName;
}
