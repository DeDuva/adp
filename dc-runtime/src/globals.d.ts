/**
 * The runtime deliberately reaches React through globals rather than importing
 * it: `docs/html/support.js` is a plain classic script, and React arrives from
 * the sibling files the build vendors alongside it. The UMD global types that
 * ship with `@types/react` model a *module* import and contradict that, so the
 * shapes this runtime actually relies on are declared here instead.
 */
declare global {
  interface Window {
    /** React UMD global, present once the vendored bundles have executed. */
    React?: any;
    /** ReactDOM UMD global, same. */
    ReactDOM?: any;
    /** `@babel/standalone`, only ever present if a host page supplied it. */
    Babel?: any;
    /** Host-supplied URL rewrites for `x-import` sources, keyed by original URL. */
    __resources?: Record<string, string>;
    /** Host-supplied pre-fetched `x-import` sources, keyed by original URL. */
    __resourceBlobs?: Record<string, Blob>;
    /** Marks this runtime as the content-keyed generation, for host editors. */
    __dcContentKeyed?: boolean;
  }
}

export {};
