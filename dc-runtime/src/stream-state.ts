export function createStreamTracker(staleMs = 6e4, now = Date.now) {
  const since = /* @__PURE__ */ new Map();
  const liveOne = (n) => {
    const t = since.get(n);
    if (t === void 0) return false;
    if (now() - t > staleMs) {
      since.delete(n);
      return false;
    }
    return true;
  };
  return {
    push(name, streaming, viewportKey) {
      if (viewportKey === "dc-model") return;
      if (streaming) since.set(name, now());
      else since.delete(name);
    },
    live(name) {
      if (name !== void 0) return liveOne(name);
      for (const n of [...since.keys()]) if (liveOne(n)) return true;
      return false;
    }
  };
}
