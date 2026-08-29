export function bundledBlob(url) {
  const blobs = window.__resourceBlobs;
  const b = blobs ? blobs[url.split("#")[0]] : void 0;
  return b instanceof Blob ? b : null;
}
