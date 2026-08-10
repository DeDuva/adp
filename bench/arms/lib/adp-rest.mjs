// Minimal REST helpers shared by arm 2's three-way-cost driver. Node built-ins
// only (`fetch`), same "zero runtime dependencies" stance as the rest of bench/.

export function adpClient(baseUrl, token) {
  async function call(method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      throw new Error(`${method} ${path} -> ${res.status}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
    }
    return parsed;
  }

  return {
    createRepo: (owner, name) => call("POST", `/api/v3/repos/${owner}`, { name }),
    createIssue: (owner, repo, title, body) => call("POST", `/api/v3/repos/${owner}/${repo}/issues`, { title, body }),
    getIssue: (owner, repo, number) => call("GET", `/api/v3/repos/${owner}/${repo}/issues/${number}`),
    cloneUrl: (owner, repo) => {
      const u = new URL(baseUrl);
      u.username = "x-access-token";
      u.password = token;
      u.pathname = `/${owner}/${repo}.git`;
      return u.toString();
    },
  };
}
