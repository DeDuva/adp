const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;
export function resolve(vals, src) {
  const expr = String(src).trim();
  if (!expr) return void 0;
  if (expr[0] === "(" && expr[expr.length - 1] === ")" && parensWrapWhole(expr)) {
    return resolve(vals, expr.slice(1, -1));
  }
  const eq = findTopLevelEquality(expr);
  if (eq) {
    const lv = resolve(vals, expr.slice(0, eq.index));
    const rv = resolve(vals, expr.slice(eq.index + eq.op.length));
    switch (eq.op) {
      case "===":
        return lv === rv;
      case "!==":
        return lv !== rv;
      case "==":
        return lv == rv;
      default:
        return lv != rv;
    }
  }
  if (expr[0] === "!") return !resolve(vals, expr.slice(1));
  if (expr === "true") return true;
  if (expr === "false") return false;
  if (expr === "null") return null;
  if (expr === "undefined") return void 0;
  if (NUMBER_RE.test(expr)) return Number(expr);
  if (expr.length >= 2 && (expr[0] === '"' || expr[0] === "'") && expr[expr.length - 1] === expr[0]) {
    return expr.slice(1, -1);
  }
  return resolvePath(vals, expr);
}
function parensWrapWhole(expr) {
  let depth = 0;
  for (let i = 0; i < expr.length - 1; i++) {
    if (expr[i] === "(") depth++;
    else if (expr[i] === ")") {
      depth--;
      if (depth === 0) return false;
    }
  }
  return true;
}
function findTopLevelEquality(expr) {
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (depth === 0 && (c === "=" || c === "!") && expr[i + 1] === "=") {
      if (i > 0 && (expr[i - 1] === "=" || expr[i - 1] === "!")) continue;
      if (!expr.slice(0, i).trim()) continue;
      const op = expr[i + 2] === "=" ? c + "==" : c + "=";
      return { index: i, op };
    }
  }
  return null;
}
function resolvePath(vals, expr) {
  const head = expr.match(IDENT_RE);
  if (!head) return void 0;
  let cur = vals == null ? void 0 : vals[head[0]];
  let i = head[0].length;
  while (i < expr.length) {
    if (expr[i] === ".") {
      const m = expr.slice(i + 1).match(IDENT_RE) || expr.slice(i + 1).match(/^\d+/);
      if (!m) return void 0;
      cur = cur == null ? void 0 : cur[m[0]];
      i += 1 + m[0].length;
    } else if (expr[i] === "[") {
      let depth = 1;
      let j = i + 1;
      while (j < expr.length && depth > 0) {
        if (expr[j] === "[") depth++;
        else if (expr[j] === "]") {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      if (depth !== 0) return void 0;
      const key = resolve(vals, expr.slice(i + 1, j));
      cur = cur == null ? void 0 : cur[key];
      i = j + 1;
    } else {
      return void 0;
    }
  }
  return cur;
}
