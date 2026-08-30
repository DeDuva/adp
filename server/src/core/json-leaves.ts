// One walk over an arbitrary JSON value, visiting its string leaves.
//
// Two things in this codebase need it and they need the same one. #148's
// detector rewrites a string leaf to remove a secret; #199's structural
// projection rewrites a string leaf to remove the *content*. A second walker
// for the second job would be two definitions of "where the strings are", and
// they would drift — the first payload shape one of them handled and the other
// did not would be a silent hole in whichever was behind.
//
// What the walk does *not* do is the load-bearing part. Object keys are never
// visited or rewritten: a key is structure, and rewriting one would change the
// shape of a payload ADP promises not to interpret, making the rewrite
// indistinguishable from the harness having written a different document.
// Nothing here branches on the payload's shape either — it knows only that
// JSON has objects, arrays and leaves — so a harness storing its own format
// still needs no ADP change.

/** Where a leaf was, as a JSON path: `$.tool_output`, `$.messages[2].text`. */
export type LeafPath = string;

/**
 * Rebuilds `value` with every string leaf replaced by `visit`'s return.
 *
 * Numbers, booleans and null round-trip unchanged: neither caller can act on
 * them — a number cannot carry a secret the engine recognises, and it costs
 * nothing worth projecting away.
 */
export function mapStringLeaves(value: unknown, visit: (text: string, path: LeafPath) => string): unknown {
  return walk(value, "$", visit);
}

function walk(value: unknown, path: LeafPath, visit: (text: string, path: LeafPath) => string): unknown {
  if (typeof value === "string") return visit(value, path);
  if (Array.isArray(value)) return value.map((entry, index) => walk(entry, `${path}[${index}]`, visit));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = walk(entry, `${path}.${key}`, visit);
    }
    return out;
  }
  return value;
}
