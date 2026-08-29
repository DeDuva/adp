export function parseDcDocument(doc) {
  const dc = doc.querySelector("x-dc");
  if (!dc) return null;
  const scriptEl = doc.querySelector("script[data-dc-script]");
  const { props, preview } = parseDataProps(
    scriptEl?.getAttribute("data-props") ?? null
  );
  return {
    template: dc.innerHTML,
    js: scriptEl ? scriptEl.textContent || "" : "",
    props,
    preview
  };
}
export function parseDcText(src) {
  const openMatch = /<x-dc(?:\s[^>]*)?>/.exec(src);
  if (!openMatch) return null;
  const close = src.lastIndexOf("</x-dc>");
  if (close === -1 || close < openMatch.index) return null;
  const template = src.slice(openMatch.index + openMatch[0].length, close);
  const doc = new DOMParser().parseFromString(src, "text/html");
  const scriptEl = doc.querySelector("script[data-dc-script]");
  const { props, preview } = parseDataProps(
    scriptEl?.getAttribute("data-props") ?? null
  );
  return {
    template,
    js: scriptEl ? scriptEl.textContent || "" : "",
    props,
    preview
  };
}
export function parseDataProps(raw) {
  if (!raw) return { props: null, preview: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { props: null, preview: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { props: null, preview: null };
  }
  const obj = parsed;
  const preview = obj.$preview && typeof obj.$preview === "object" ? obj.$preview : null;
  const rest = {};
  for (const k of Object.keys(obj)) {
    if (k[0] !== "$") rest[k] = obj[k];
  }
  return { props: Object.keys(rest).length ? rest : null, preview };
}
export function dcNameFromPath(pathname) {
  let p = pathname || "";
  try {
    p = decodeURIComponent(p);
  } catch {
  }
  const base = p.split("/").pop() || "Root";
  return base.replace(/\.dc\.html$/, "").replace(/\.html?$/, "") || "Root";
}
