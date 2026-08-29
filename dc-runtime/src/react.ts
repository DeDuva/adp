export function getReact() {
  const R = window.React;
  if (!R) throw new Error("dc-runtime: window.React is not available yet");
  return R;
}
export function getReactDOM() {
  const RD = window.ReactDOM;
  if (!RD) throw new Error("dc-runtime: window.ReactDOM is not available yet");
  return RD;
}
/** `React.createElement`, resolved lazily so the UMD global can arrive first. */
export const h = ((...args) => getReact().createElement(
  ...args
)) as (...args: any[]) => any;
