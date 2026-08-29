function scanUnquotedUrl(css, i) {
  if (css[i] !== "u" && css[i] !== "U" || css.slice(i, i + 4).toLowerCase() !== "url(" || /[a-z0-9_-]/i.test(css[i - 1] ?? "")) {
    return -1;
  }
  let j = i + 4;
  while (j < css.length && /\s/.test(css[j])) j++;
  if (css[j] === '"' || css[j] === "'") return -1;
  while (j < css.length && css[j] !== ")") {
    if (css[j] === "\\") j++;
    j++;
  }
  return j < css.length ? j + 1 : css.length;
}
function stripComments(css) {
  let out = "";
  let quote = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === "\\") {
        out += c + (css[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === quote) quote = "";
      out += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      out += c;
    } else if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 1;
      out += " ";
    } else {
      const end = scanUnquotedUrl(css, i);
      if (end === -1) out += c;
      else {
        out += css.slice(i, end);
        i = end - 1;
      }
    }
  }
  return out;
}
function importantify(css) {
  css = stripComments(css);
  const decls = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      decls.push(css.slice(start, i));
      start = i + 1;
    } else {
      const end = scanUnquotedUrl(css, i);
      if (end !== -1) i = end - 1;
    }
  }
  decls.push(css.slice(start));
  return decls.map((d) => d.trim()).filter(Boolean).map((d) => /!\s*important$/i.test(d) ? d : d + " !important").join(";");
}
export function createPseudoSheet(doc) {
  let el = null;
  const cache = /* @__PURE__ */ new Map();
  let n = 0;
  return (pseudo, css) => {
    const k = pseudo + "|" + css;
    const hit = cache.get(k);
    if (hit) return hit;
    if (!el) {
      el = doc.createElement("style");
      doc.head.appendChild(el);
    }
    const cls = "scp" + (n++).toString(36);
    const isPseudoElement = pseudo === "before" || pseudo === "after";
    const sel = isPseudoElement ? "." + cls + "::" + pseudo : "." + cls + ":" + pseudo;
    el.sheet.insertRule(
      sel + "{" + (isPseudoElement ? css : importantify(css)) + "}",
      el.sheet.cssRules.length
    );
    cache.set(k, cls);
    return cls;
  };
}
