export function createRegistry() {
  const entries = /* @__PURE__ */ Object.create(null);
  function get(name) {
    return entries[name] || (entries[name] = {
      html: "",
      tpl: null,
      Logic: null,
      jsStreaming: false,
      htmlStreaming: false,
      ver: 0,
      subs: /* @__PURE__ */ new Set(),
      fetched: false
    });
  }
  function bump(name) {
    const r = get(name);
    r.ver++;
    for (const fn of r.subs) fn();
  }
  return {
    entries,
    get,
    bump,
    bumpAll() {
      for (const n in entries) bump(n);
    }
  };
}
