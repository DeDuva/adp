// Deterministic JSON serialization for anything that gets hashed.
//
// `JSON.stringify` preserves *insertion* order, so two objects that are equal by
// every meaning anyone cares about serialize differently depending on the order
// a client happened to build them in. That is harmless for a payload nobody
// re-derives and fatal for a hash chain, whose entire value is that an
// independent party can recompute it and get the same answer. Keys are sorted at
// every depth; arrays keep their order, because in an array order is content.
//
// This is RFC 8785 (JCS) in spirit but not in letter: number formatting follows
// JavaScript's own `JSON.stringify`, which is ES2020 `Number::toString` and
// agrees with JCS for every value that survives a JSON round-trip. Anything that
// needs byte-exact interoperability with a non-JavaScript verifier should be
// hashing a hex digest, not a float.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  // Date and friends would otherwise serialize as `{}` after this walk, losing
  // the value silently. Let toJSON run first, then canonicalize the result.
  const maybeJson = value as { toJSON?: () => unknown };
  if (typeof maybeJson.toJSON === "function") return sortKeys(maybeJson.toJSON());

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    // Match JSON.stringify: an explicit `undefined` property is absent, not null.
    if (entry === undefined) continue;
    out[key] = sortKeys(entry);
  }
  return out;
}
