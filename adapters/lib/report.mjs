// The one thing every scanner-as-gate adapter does at the end: POST a typed
// result to the substrate that actually attests it (docs/pragmatic_mvp.md M2
// — "SARIF/JSON in, DSSE evidence attestation in; this server is the
// receiving and attestation end, same shape as GitHub's own Checks API").
// Kept tiny and dependency-free deliberately — an adapter is a script that
// runs in someone else's CI, where adding a package manager step just to
// report a result would be the wrong trade.
export async function reportGate({ serverUrl, token, owner, repo, sha, name, status, summary }) {
  const url = `${serverUrl.replace(/\/+$/, "")}/api/v3/repos/${owner}/${repo}/gates`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ git_sha: sha, name, status, summary }),
  });

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const message = body && typeof body === "object" && "message" in body ? body.message : `HTTP ${res.status}`;
    throw new Error(`gate report to ${url} failed: ${message}`);
  }

  return body;
}
