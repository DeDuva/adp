import { resolve } from './expr.js';

export const CAMEL_ATTR = "sc-camel-";
export const INLINE_TEXT_TAGS = new Set(
  "a abbr b bdi bdo br cite code del dfn em i ins kbd mark q s samp small span strike strong sub sup u var wbr".split(
    " "
  )
);
const RAW_WRAP = {
  select: "sc-raw-select",
  table: "sc-raw-table",
  tbody: "sc-raw-tbody",
  thead: "sc-raw-thead",
  tfoot: "sc-raw-tfoot",
  tr: "sc-raw-tr",
  td: "sc-raw-td",
  th: "sc-raw-th",
  caption: "sc-raw-caption"
};
export const RAW_UNWRAP = Object.fromEntries(
  Object.entries(RAW_WRAP).map(([k, v]) => [v, k])
);
export const EVENT_MAP = {
  onclick: "onClick",
  onchange: "onChange",
  oninput: "onInput",
  onsubmit: "onSubmit",
  onkeydown: "onKeyDown",
  onkeyup: "onKeyUp",
  onkeypress: "onKeyPress",
  onmousedown: "onMouseDown",
  onmouseup: "onMouseUp",
  onmouseenter: "onMouseEnter",
  onmouseleave: "onMouseLeave",
  onfocus: "onFocus",
  onblur: "onBlur",
  ondoubleclick: "onDoubleClick",
  oncontextmenu: "onContextMenu",
  onmousemove: "onMouseMove",
  onmouseover: "onMouseOver",
  onmouseout: "onMouseOut",
  onpointerdown: "onPointerDown",
  onpointerup: "onPointerUp",
  onpointermove: "onPointerMove",
  onpointerenter: "onPointerEnter",
  onpointerleave: "onPointerLeave",
  onpointercancel: "onPointerCancel",
  onpointerover: "onPointerOver",
  onpointerout: "onPointerOut",
  ongotpointercapture: "onGotPointerCapture",
  onlostpointercapture: "onLostPointerCapture",
  ontouchstart: "onTouchStart",
  ontouchend: "onTouchEnd",
  ontouchmove: "onTouchMove",
  ontouchcancel: "onTouchCancel",
  ondragstart: "onDragStart",
  ondragend: "onDragEnd",
  ondragenter: "onDragEnter",
  ondragleave: "onDragLeave",
  ondragover: "onDragOver",
  onanimationstart: "onAnimationStart",
  onanimationend: "onAnimationEnd",
  onanimationiteration: "onAnimationIteration",
  ontransitionend: "onTransitionEnd"
};
const ATTRS = `(?:[^>"']|"[^"]*"|'[^']*')*`;
const IMPORT_SELF_CLOSE_RE = new RegExp(
  "<(x-import|dc-import)(" + ATTRS + ")/>",
  "gi"
);
const CAMEL_ATTR_RE = /(\s)([a-z]+[A-Z][A-Za-z0-9]*)(\s*=)/g;
function encodeCamelAttrs(html) {
  return html.replace(
    CAMEL_ATTR_RE,
    (_, sp, name, eq) => sp + CAMEL_ATTR + name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()) + eq
  );
}
export function encodeCase(html) {
  html = html.replace(
    IMPORT_SELF_CLOSE_RE,
    (_, t, a) => "<" + t + a + "></" + t + ">"
  );
  html = html.replace(/<helmet(\s|>)/gi, "<sc-helmet$1");
  html = html.replace(/<\/helmet\s*>/gi, "</sc-helmet>");
  html = encodeCamelAttrs(html);
  for (const [real, alias] of Object.entries(RAW_WRAP)) {
    html = html.replace(
      new RegExp("(</?)" + real + "(?=[\\s>])", "gi"),
      "$1" + alias
    );
  }
  return html;
}
export function kebabToCamel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
export function cssToObj(css) {
  const o = {};
  for (const decl of css.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    o[prop.startsWith("--") ? prop : kebabToCamel(prop)] = decl.slice(i + 1).trim();
  }
  return o;
}
export function compileAttr(raw) {
  const whole = raw.match(/^\s*\{\{([\s\S]+?)\}\}\s*$/);
  if (whole) {
    const path = whole[1];
    return (vals) => resolve(vals, path);
  }
  if (raw.includes("{{")) {
    const parts = raw.split(/\{\{([\s\S]+?)\}\}/g);
    return (vals) => parts.map((s, i) => i & 1 ? resolve(vals, s) ?? "" : s).join("");
  }
  return () => raw;
}
