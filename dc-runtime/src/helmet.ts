import { ATOMIC_CSS } from './atomics.js';
import { bundledBlob } from './bundled.js';

export const DESIGN_DOC_MODE_RE = /<meta\b[^>]*\bname\s*=\s*["']design_doc_mode["'][^>]*\b(?:content|value)\s*=\s*["'](\w+)["']/i;
const CANVAS_BG_LIGHT = "#f0eee6";
const CANVAS_BG_DARK = "#2e2c26";
export function createHelmetManager(doc, isStreaming) {
  const mounted = /* @__PURE__ */ new Set();
  const live = /* @__PURE__ */ new Map();
  let designDocMode = null;
  let canvasStyleEl = null;
  let appTheme = "light";
  try {
    const ds = doc.documentElement.dataset.theme;
    appTheme = ds === "dark" || ds === "light" ? ds : new URLSearchParams(doc.defaultView?.location.search ?? "").get(
      "theme"
    ) === "dark" ? "dark" : "light";
  } catch {
  }
  function applyCanvasBg() {
    if (!canvasStyleEl) return;
    const bg = appTheme === "dark" ? CANVAS_BG_DARK : CANVAS_BG_LIGHT;
    canvasStyleEl.textContent = `html,body{background:${bg}}#dc-root>.sc-host{position:relative}`;
  }
  function postDesignMode(mode) {
    if (window.parent === window) return;
    try {
      window.parent.postMessage({ type: "__dc_design_mode", mode }, "*");
    } catch {
    }
  }
  function setDesignDocMode(mode) {
    if (mode === designDocMode) return;
    designDocMode = mode;
    postDesignMode(mode);
    if (mode === "canvas") {
      doc.documentElement.setAttribute("data-dc-canvas", "");
      canvasStyleEl = doc.createElement("style");
      canvasStyleEl.setAttribute("data-dc-canvas", "");
      applyCanvasBg();
      doc.head.appendChild(canvasStyleEl);
    } else {
      doc.documentElement.removeAttribute("data-dc-canvas");
      canvasStyleEl?.remove();
      canvasStyleEl = null;
    }
  }
  window.addEventListener("message", (e) => {
    const type = e.data && e.data.type;
    if (type === "__dc_theme") {
      const t = e.data.theme;
      if (t === "light" || t === "dark") {
        appTheme = t;
        applyCanvasBg();
      }
      return;
    }
    if (!designDocMode || type !== "__dc_probe") return;
    postDesignMode(designDocMode);
  });
  function compile(node) {
    const raw = [...node.children];
    const helmetClosed = node.nextSibling != null || node.parentNode?.nextSibling != null;
    if (node.hasAttribute("data-dc-atomics") && !mounted.has("__dc-atomics")) {
      mounted.add("__dc-atomics");
      const el = doc.createElement("style");
      el.id = "__dc-atomics";
      el.textContent = ATOMIC_CSS;
      doc.head.appendChild(el);
    }
    return (_vals, ctx) => {
      const name = ctx && ctx.__name || "";
      const streaming = !!(name && isStreaming(name));
      for (let i = 0; i < raw.length; i++) {
        const child = raw[i];
        const tag = child.tagName;
        const mayBePartial = streaming && !helmetClosed && i === raw.length - 1;
        if (tag === "SCRIPT") {
          if (mayBePartial) continue;
          const key = "SCRIPT|" + (child.getAttribute("src") || child.textContent || "");
          if (mounted.has(key)) continue;
          mounted.add(key);
          const el = doc.createElement("script");
          for (const { name: an, value } of [...child.attributes])
            el.setAttribute(an, value);
          if (child.textContent) el.textContent = child.textContent;
          doc.head.appendChild(el);
        } else if (tag === "LINK" || tag === "META") {
          if (mayBePartial) continue;
          const key = tag + "|" + (child.getAttribute("href") || child.getAttribute("src") || child.outerHTML);
          if (mounted.has(key)) continue;
          mounted.add(key);
          if (tag === "LINK") {
            const rel = (child.getAttribute("rel") || "").toLowerCase().split(/\s+/);
            const href = (child.getAttribute("href") || "").trim();
            const res = window.__resources;
            const pre = res && rel.includes("stylesheet") && !rel.includes("alternate") ? res[href] : void 0;
            const blob = typeof pre === "string" && pre ? bundledBlob(pre) : null;
            if (blob) {
              const el = doc.createElement("style");
              if (child.hasAttribute("disabled")) {
                el.setAttribute("media", "not all");
              } else if (child.getAttribute("media")) {
                el.setAttribute("media", child.getAttribute("media"));
              }
              if (child.getAttribute("title"))
                el.setAttribute("title", child.getAttribute("title"));
              void blob.text().then((css) => {
                el.textContent = css;
              });
              doc.head.appendChild(el);
              continue;
            }
          }
          doc.head.appendChild(child.cloneNode(true));
        } else {
          const key = name + "|" + i;
          let el = live.get(key);
          if (!el || el.tagName !== tag) {
            if (el) el.remove();
            el = doc.createElement(tag.toLowerCase());
            live.set(key, el);
            doc.head.appendChild(el);
          }
          for (const { name: an, value } of [...child.attributes]) {
            if (el.getAttribute(an) !== value) el.setAttribute(an, value);
          }
          if (el.textContent !== child.textContent)
            el.textContent = child.textContent;
        }
      }
      return null;
    };
  }
  return { compile, setDesignDocMode };
}
