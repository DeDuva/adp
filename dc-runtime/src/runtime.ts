import { compileTemplate } from './compile.js';
import { Placeholder, createComponentFactory } from './component.js';
import { createExternalModules } from './external.js';
import { DESIGN_DOC_MODE_RE, createHelmetManager } from './helmet.js';
import { createPseudoSheet } from './pseudo.js';
import { createRegistry } from './registry.js';
import { bundledBlob } from './bundled.js';
import { StreamableLogic, evalDcLogic } from './logic.js';
import { parseDataProps, parseDcText } from './parse.js';
import { resolve } from './expr.js';
import { h } from './react.js';

const COMPONENT_DIR = ".";
export function createRuntime(doc = document) {
  const registry = createRegistry();
  const pseudoClass = createPseudoSheet(doc);
  const helmet = createHelmetManager(
    doc,
    (name) => registry.get(name).htmlStreaming
  );
  const external = createExternalModules(() => registry.bumpAll());
  const factory = createComponentFactory(registry, ensureFetched);
  const host = {
    component: (name) => factory.getDC(name),
    placeholder: (props) => h(Placeholder, props),
    helmet: (node) => helmet.compile(node),
    loadExternal: (kind, url, after) => external.load(kind, url, after),
    resolveExternal: (url, name) => external.resolve(url, name),
    resolveExternalGlobal: (url, name) => external.resolveGlobal(url, name),
    resolveExternalError: (url, name) => external.getError(url, name),
    pseudoClass
  };
  function ensureFetched(name) {
    const r = registry.get(name);
    if (r.fetched) return;
    r.fetched = true;
    const url = COMPONENT_DIR + "/" + encodeURIComponent(name) + ".dc.html";
    const res = window.__resources;
    const pre = res ? res[url] : void 0;
    const target = typeof pre === "string" && pre ? pre : url;
    const blob = bundledBlob(target);
    (blob ? blob.text() : fetch(target).then((res2) => {
      if (!res2.ok) {
        console.error(
          '[dc-runtime] sibling fetch for "' + name + '" failed:',
          url,
          "returned",
          res2.status,
          "\u2014 the reference renders as an empty placeholder."
        );
        return "";
      }
      return res2.text();
    })).then((t) => {
      if (!t) return;
      const parsed = parseDcText(t);
      if (!parsed) {
        console.error(
          '[dc-runtime] sibling fetch for "' + name + '":',
          url,
          "has no <x-dc> block \u2014 not a Design Component."
        );
        return;
      }
      if (parsed.props) r.propsMeta = parsed.props;
      if (parsed.preview) r.preview = parsed.preview;
      if (parsed.template && !r.html) updateHtml(name, parsed.template);
      if (parsed.js && !r.Logic) updateJs(name, parsed.js);
    }).catch(
      (e) => console.error(
        '[dc-runtime] sibling fetch for "' + name + '" threw:',
        url,
        e
      )
    );
  }
  let rootName = null;
  function updateHtml(name, html) {
    const r = registry.get(name);
    r.html = html;
    if (name === rootName) {
      const mode = DESIGN_DOC_MODE_RE.exec(html)?.[1] ?? null;
      if (mode || !r.htmlStreaming) helmet.setDesignDocMode(mode);
    }
    try {
      r.tpl = compileTemplate(html, host);
    } catch (e) {
      console.error("[dc-runtime] template compile FAILED for", name, e);
    }
    registry.bump(name);
  }
  function updateJs(name, src) {
    const r = registry.get(name);
    const seq = r.jsSeq = (r.jsSeq || 0) + 1;
    try {
      const Cls = evalDcLogic(src);
      if (r.jsSeq !== seq) return;
      if (typeof Cls !== "function") {
        r.logicError = name + ".dc.html: <script data-dc-script> must define `class Component extends DCLogic`";
      } else {
        r.logicError = null;
        r.Logic = Cls;
      }
    } catch (e) {
      if (r.jsSeq !== seq) return;
      console.error(
        "[dc-runtime] logic class eval FAILED for",
        name,
        "\u2014 the template renders with props only.",
        e
      );
      r.logicError = name + ": " + (e instanceof Error && e.message ? e.message : String(e));
    }
    registry.bump(name);
  }
  function setStreaming(name, kind, on) {
    const r = registry.get(name);
    if (kind === "html") r.htmlStreaming = !!on;
    else r.jsStreaming = !!on;
    let any = false;
    for (const n in registry.entries) {
      const e = registry.entries[n];
      if (e && (e.htmlStreaming || e.jsStreaming)) {
        any = true;
        break;
      }
    }
    doc.documentElement.classList.toggle("sc-dc-streaming", any);
    registry.bump(name);
  }
  function dcUpdate(name, kind, content, streaming) {
    if (streaming) registry.get(name).fetched = true;
    if (kind === "html") {
      setStreaming(name, "html", !!streaming);
      updateHtml(name, content);
    } else if (kind === "js") {
      setStreaming(name, "js", !!streaming);
      if (!streaming) updateJs(name, content);
    } else if (kind === "props") {
      const { props, preview } = parseDataProps(content);
      const r = registry.get(name);
      r.propsMeta = props ?? void 0;
      r.preview = preview;
      registry.bump(name);
    }
  }
  function setProps(name, overrides) {
    registry.get(name).propOverrides = overrides && typeof overrides === "object" ? { ...overrides } : null;
    registry.bump(name);
  }
  function adoptParsed(name, parsed) {
    if (!parsed) return;
    const r = registry.get(name);
    if (parsed.props) r.propsMeta = parsed.props;
    if (parsed.preview) r.preview = parsed.preview;
    if (parsed.template) updateHtml(name, parsed.template);
    if (parsed.js) updateJs(name, parsed.js);
  }
  return {
    registry,
    getDC: factory.getDC,
    updateHtml,
    updateJs,
    dcUpdate,
    setProps,
    adoptParsed,
    setRootName: (name) => {
      rootName = name;
    },
    markFetched: (name) => {
      registry.get(name).fetched = true;
    },
    annotatedTemplate: (name) => {
      const r = registry.get(name);
      return r.tpl && r.tpl.__annotated || null;
    },
    templateSource: (name) => registry.get(name).html || null,
    StreamableLogic
  };
}
