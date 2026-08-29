import { CAMEL_ATTR, EVENT_MAP, INLINE_TEXT_TAGS, RAW_UNWRAP, compileAttr, cssToObj, encodeCase, kebabToCamel } from './encode.js';
import { resolve } from './expr.js';
import { getReact, h } from './react.js';

/** A compiled template: the render closure, which also carries the annotated
 *  template source the editor bridge reads back. */
type CompiledRender = ((vals: any, ctx?: any) => any) & { __annotated?: string };

function collectProps(node, kind, host) {
  const propGetters = [];
  const pseudoClasses = [];
  let hintSize = null;
  for (const { name, value } of [...node.attributes]) {
    if (name === "sc-name" || name === "data-dc-tpl") continue;
    let key = name;
    if (key.startsWith(CAMEL_ATTR))
      key = kebabToCamel(key.slice(CAMEL_ATTR.length));
    if (key === "hint-size") {
      hintSize = value;
      continue;
    }
    if (key.startsWith("style-")) {
      pseudoClasses.push(host.pseudoClass(key.slice(6), value));
      continue;
    }
    if (kind !== "dom") {
      if (key.includes("-") && !(kind === "x-import" && (key.startsWith("aria-") || key.startsWith("data-"))))
        key = kebabToCamel(key);
    } else {
      if (key === "class") key = "className";
      else if (key === "for") key = "htmlFor";
      else if (key.startsWith("on"))
        key = EVENT_MAP[key] || "on" + key[2].toUpperCase() + key.slice(3);
    }
    propGetters.push([key, compileAttr(value)]);
  }
  return { propGetters, pseudoClasses, hintSize };
}
const HOST_STYLE_PROPS = /* @__PURE__ */ new Set([
  "position",
  "left",
  "right",
  "top",
  "bottom",
  "inset",
  "width",
  "height",
  "z-index",
  "transform"
]);
function hostPositionStyle(style) {
  const all = typeof style === "string" ? cssToObj(style) : style != null && typeof style === "object" ? style : null;
  if (!all) return void 0;
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    const kebab = k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
    if (HOST_STYLE_PROPS.has(kebab)) out[k] = v;
  }
  return Object.keys(out).length ? out : void 0;
}
export function compileTemplate(html, host) {
  const tpl = document.createElement("template");
  //! nosemgrep: direct-inner-html-assignment
  tpl.innerHTML = encodeCase(html);
  let tplN = 0;
  (function stamp(node: any) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      node.setAttribute("data-dc-tpl", String(tplN++));
    }
    for (const c of node.childNodes) stamp(c);
  })(tpl.content);
  const builders = walkChildren(tpl.content, host);
  const render = ((vals, ctx) => builders.map((b, i) => b(vals || {}, ctx, i))) as CompiledRender;
  render.__annotated = tpl.innerHTML;
  return render;
}
function walkChildren(node, host) {
  return [...node.childNodes].map((c) => walk(c, host)).filter((b) => b != null);
}
const SLIDE_ID_VALUE_RE = /^[0-9a-f]{8}$/;
const DECK_CONTROL_FLOW_RE = /^(sc-if|sc-for|sc-else|dc-import|x-import)$/;
const DECK_AUX_RE = /^(template|script|style|sc-helmet|helmet)$/;
function isDeckMountTag(el) {
  if (el.localName === "deck-stage") return true;
  return el.localName === "x-import" && (el.getAttribute("component-from-global-scope") || "") === "deck-stage";
}
function walkDeckChildren(el, host) {
  const pairs = [...el.childNodes].map((c) => ({ c, b: walk(c, host) })).filter((p) => p.b !== null);
  const kids = pairs.map((p) => p.b);
  const seen = /* @__PURE__ */ new Set();
  const wsSeen = /* @__PURE__ */ new Map();
  const keys = [];
  const nextSlideId = new Array(pairs.length);
  {
    let upcoming = null;
    for (let j = pairs.length - 1; j >= 0; j--) {
      const n = pairs[j].c;
      if (n.nodeType === Node.ELEMENT_NODE) {
        const t = n.localName;
        upcoming = !DECK_AUX_RE.test(t) && !DECK_CONTROL_FLOW_RE.test(t) ? n.getAttribute("data-om-slide-id") : null;
      }
      nextSlideId[j] = upcoming;
    }
  }
  for (let j = 0; j < pairs.length; j++) {
    const { c } = pairs[j];
    if (c.nodeType === Node.TEXT_NODE) {
      if ((c.nodeValue ?? "").trim() === "") {
        const base = nextSlideId[j] ? "omid-ws:" + nextSlideId[j] : "omid-ws:aux";
        const n = wsSeen.get(base) ?? 0;
        wsSeen.set(base, n + 1);
        keys.push(n === 0 ? base : base + ":" + n);
        continue;
      }
      return { kids, keys: null };
    }
    if (c.nodeType !== Node.ELEMENT_NODE) {
      keys.push(j);
      continue;
    }
    const child = c;
    const tag = child.localName;
    if (DECK_AUX_RE.test(tag)) {
      keys.push(j);
      continue;
    }
    if (DECK_CONTROL_FLOW_RE.test(tag)) return { kids, keys: null };
    const v = child.getAttribute("data-om-slide-id");
    if (!v || !SLIDE_ID_VALUE_RE.test(v) || seen.has(v)) {
      return { kids, keys: null };
    }
    seen.add(v);
    keys.push("omid:" + v);
  }
  return { kids, keys };
}
function renderDeckKids(kids, kidKeys, vals, ctx) {
  return kids.map((b, j) => {
    const k = kidKeys ? kidKeys[j] : j;
    const out = b(vals, ctx, k);
    return kidKeys != null && typeof out === "string" ? h(getReact().Fragment, { key: k }, out) : out;
  });
}
function walk(node, host) {
  if (node.nodeType === Node.TEXT_NODE) return walkText(node);
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node;
  const tag = el.tagName.toLowerCase();
  if (tag === "sc-for") return walkFor(el, host);
  if (tag === "sc-if") return walkIf(el, host);
  if (tag === "x-import") return walkXImport(el, host);
  if (tag === "sc-helmet") return host.helmet(el);
  if (tag === "dc-import") return walkComponent(el, host);
  return walkElement(el, host);
}
const warnedHoles = /* @__PURE__ */ new Set();
function warnUnresolved(ctx, what) {
  const key = (ctx?.__name || "?") + "\0" + what;
  if (warnedHoles.has(key)) return;
  warnedHoles.add(key);
  console.warn("[dc-runtime] " + (ctx?.__name || "template") + ": " + what);
}
function walkText(node) {
  const txt = node.nodeValue ?? "";
  if (!txt.includes("{{")) {
    if (!txt.trim() && !txt.includes(" ")) return null;
    return () => txt;
  }
  const parts = txt.split(/\{\{([\s\S]+?)\}\}/g);
  return (vals, ctx, key) => h(
    getReact().Fragment,
    { key },
    ...parts.map((p, i) => {
      if (!(i & 1)) return p;
      const v = resolve(vals, p);
      if (v === void 0) {
        if (!ctx?.__streamingNow) {
          if (document.body?.hasAttribute("data-dc-editor-on")) {
            return h(
              "span",
              { key: i, className: "sc-interp sc-unresolved" },
              "{{ " + p.trim() + " }}"
            );
          }
          warnUnresolved(
            ctx,
            "{{ " + p.trim() + " }} never resolved \u2014 rendered as empty"
          );
          return null;
        }
        return h(
          "span",
          { key: i, className: "sc-interp sc-missing" },
          p.trim()
        );
      }
      if (getReact().isValidElement(v) || Array.isArray(v)) {
        return h(getReact().Fragment, { key: i }, v);
      }
      if (v === null || typeof v === "boolean") return null;
      return h("span", { key: i, className: "sc-interp" }, String(v));
    })
  );
}
function walkFor(el, host) {
  const listGet = compileAttr(el.getAttribute("list") || "");
  const asName = el.getAttribute("as") || "item";
  const hintN = parseInt(el.getAttribute("hint-placeholder-count") || "0", 10);
  const kids = walkChildren(el, host);
  const listSrc = el.getAttribute("list") || "";
  return (vals, ctx, key) => {
    let list = listGet(vals);
    if (!Array.isArray(list)) {
      if (!ctx?.__streamingNow) {
        if (list !== void 0 && list !== null) {
          warnUnresolved(
            ctx,
            'sc-for list="' + listSrc + '" is not an array (' + typeof list + ")"
          );
        }
        list = [];
      } else {
        list = hintN > 0 ? Array(hintN).fill(void 0) : [];
      }
    }
    return h(
      getReact().Fragment,
      { key },
      list.map((item, i) => {
        const sub = { ...vals, [asName]: item, $index: i };
        return h(
          getReact().Fragment,
          { key: i },
          kids.map((b, j) => b(sub, ctx, j))
        );
      })
    );
  };
}
function walkIf(el, host) {
  const valGet = compileAttr(el.getAttribute("value") || "");
  const hintRaw = el.getAttribute("hint-placeholder-val");
  const hintGet = hintRaw != null ? compileAttr(hintRaw) : null;
  const kids = walkChildren(el, host);
  return (vals, ctx, key) => {
    let v = valGet(vals);
    if (v === void 0 && hintGet && ctx?.__streamingNow) v = hintGet(vals);
    return v ? h(
      getReact().Fragment,
      { key },
      kids.map((b, j) => b(vals, ctx, j))
    ) : null;
  };
}
function walkComponent(el, host) {
  const name = el.getAttribute("name") || el.getAttribute("component") || "";
  el.removeAttribute("name");
  el.removeAttribute("component");
  const tplId = el.getAttribute("data-dc-tpl");
  const styleRaw = el.getAttribute("style");
  el.removeAttribute("style");
  const styleGet = styleRaw != null ? compileAttr(styleRaw) : null;
  const { propGetters, hintSize } = collectProps(el, "dc-import", host);
  const kids = walkChildren(el, host);
  return (vals, ctx, key) => {
    const props: any = {
      key,
      __hintSize: hintSize,
      __tplId: tplId,
      __hostStyle: styleGet ? hostPositionStyle(styleGet(vals)) : void 0
    };
    for (const [k, g] of propGetters) {
      const v = g(vals);
      if (k === "dcProps") {
        if (v && typeof v === "object") Object.assign(props, v);
        continue;
      }
      props[k] = v;
    }
    if (kids.length) props.children = kids.map((b, j) => b(vals, ctx, j));
    return h(host.component(name), props);
  };
}
function walkXImport(el, host) {
  const globalNameGet = compileAttr(
    el.getAttribute("component-from-global-scope") || ""
  );
  const exportNameGet = compileAttr(
    el.getAttribute("component") || el.getAttribute("name") || ""
  );
  const fromRaw = el.getAttribute("from") || (el.getAttribute("component-from-global-scope") ? "" : el.getAttribute("src") || el.getAttribute("import") || "");
  const urls = fromRaw.trim() ? fromRaw.trim().split(/\s+/) : [];
  const url = urls.length ? urls[urls.length - 1] : "";
  const kindOf = (u) => /\.(jsx|tsx)(\?|#|$)/i.test(u) ? "jsx" : "js";
  const tplId = el.getAttribute("data-dc-tpl");
  const styleRaw = el.getAttribute("style");
  el.removeAttribute("style");
  const styleGet = styleRaw != null ? compileAttr(styleRaw) : null;
  const wrap = tplId != null || styleGet != null;
  const { propGetters, hintSize } = collectProps(el, "x-import", host);
  const hasContent = el.children.length > 0 || !!(el.textContent || "").trim();
  const deckKeyed = hasContent && isDeckMountTag(el) ? walkDeckChildren(el, host) : null;
  const kids = deckKeyed ? deckKeyed.kids : hasContent ? walkChildren(el, host) : [];
  const kidKeys = deckKeyed?.keys ?? null;
  const urlBindable = fromRaw.includes("{{");
  if (urls.length && !urlBindable) {
    let prev;
    for (const u of urls) prev = host.loadExternal(kindOf(u), u, prev);
  }
  const evalName = (g, vals) => {
    const v = g(vals);
    const s = v == null ? "" : String(v);
    return s.includes("{{") ? "" : s;
  };
  return (vals, ctx, key) => {
    const globalName = evalName(globalNameGet, vals);
    const name = globalName || evalName(exportNameGet, vals);
    const C = !name || urlBindable ? null : globalName ? host.resolveExternalGlobal(url, globalName) : host.resolveExternal(url, name);
    const hostStyle = styleGet ? hostPositionStyle(styleGet(vals)) : void 0;
    const wrapper = wrap ? {
      key,
      className: "sc-host-x",
      "data-dc-tpl": tplId,
      style: hostStyle || { display: "contents" }
    } : null;
    if (!C) {
      const error = urlBindable ? "x-import `from` cannot contain {{ \u2026 }} \u2014 module URLs are resolved at parse time; use a literal URL" : host.resolveExternalError(url, name);
      const ph = host.placeholder({
        key: wrapper ? void 0 : key,
        name,
        hintSize,
        error
      });
      return wrapper ? h("div", wrapper, ph) : ph;
    }
    const props: any = wrapper ? {} : { key };
    let unresolvedHole = false;
    for (const [k, g] of propGetters) {
      if (k === "component" || k === "componentFromGlobalScope" || k === "from") {
        continue;
      }
      const v = g(vals);
      if (v === void 0) unresolvedHole = true;
      if (k === "dcProps") {
        if (v && typeof v === "object") Object.assign(props, v);
        continue;
      }
      props[k] = v;
    }
    if (unresolvedHole && ctx?.__htmlStreamingNow) {
      const ph = host.placeholder({
        key: wrapper ? void 0 : key,
        name,
        hintSize,
        error: null
      });
      return wrapper ? h("div", wrapper, ph) : ph;
    }
    if (kids.length) {
      props.children = renderDeckKids(kids, kidKeys, vals, ctx);
    }
    return wrapper ? h("div", wrapper, h(C, props)) : h(C, props);
  };
}
function contentKey(el) {
  const clone = el.cloneNode(true);
  for (const d of clone.querySelectorAll("*")) {
    while (d.attributes.length) d.removeAttribute(d.attributes[0].name);
  }
  const s = clone.innerHTML;
  let h2 = 5381;
  for (let i = 0; i < s.length; i++) h2 = (h2 << 5) + h2 + s.charCodeAt(i) | 0;
  return s.length + "." + (h2 >>> 0).toString(36);
}
const NEVER_CONTENT_KEYED = new Set(
  "script style textarea option title select canvas iframe video audio".split(
    " "
  )
);
const NOT_INLINE_SELECTOR = ":not(" + [...INLINE_TEXT_TAGS].join(",") + ")";
function walkElement(el, host) {
  const realTag = RAW_UNWRAP[el.localName] || el.localName;
  const tplId = el.getAttribute("data-dc-tpl");
  const inlineOnly = el.childNodes.length > 0 && !NEVER_CONTENT_KEYED.has(realTag) && el.querySelector(NOT_INLINE_SELECTOR) === null;
  const keySuffix = inlineOnly ? "|" + contentKey(el) : "";
  const { propGetters, pseudoClasses } = collectProps(el, "dom", host);
  const deckKeyed = isDeckMountTag(el) ? walkDeckChildren(el, host) : null;
  const kids = deckKeyed ? deckKeyed.kids : walkChildren(el, host);
  const kidKeys = deckKeyed?.keys ?? null;
  return (vals, ctx, key) => {
    const props: any = {
      key: key + keySuffix,
      "data-dc-tpl": tplId
    };
    for (const [k, g] of propGetters) {
      let v = g(vals);
      if (k === "style" && typeof v === "string") v = cssToObj(v);
      if ((k === "value" || k === "checked") && v === void 0) {
        v = k === "checked" ? false : "";
      }
      props[k] = v;
    }
    if (pseudoClasses.length) {
      props.className = [props.className, ...pseudoClasses].filter(Boolean).join(" ");
    }
    return h(realTag, props, ...renderDeckKids(kids, kidKeys, vals, ctx));
  };
}
