export interface AdpClientResult<T = unknown> {
  ok: boolean;
  status: number;
  body: T;
  message: string;
}

export interface AdpClient {
  get(path: string, query?: Record<string, unknown>): Promise<AdpClientResult>;
  post(path: string, body: unknown): Promise<AdpClientResult>;
  delete(path: string): Promise<AdpClientResult>;
}

// The MCP server is a REST client, nothing more (
// Tier 4: "Native plane | ADP REST + MCP" — MCP wraps the REST API, it
// isn't a second implementation of it). Bearer-token authenticated exactly
// like any other API consumer.
export function createAdpClient(baseUrl: string, token: string): AdpClient {
  async function request(method: string, path: string, body?: unknown): Promise<AdpClientResult> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    const message =
      parsed && typeof parsed === "object" && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : res.ok
          ? ""
          : `${method} ${path} failed with ${res.status}`;

    return { ok: res.ok, status: res.status, body: parsed, message };
  }

  return {
    get(path, query) {
      const qs = query
        ? "?" +
          Object.entries(query)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
            .join("&")
        : "";
      return request("GET", `${path}${qs}`);
    },
    post(path, body) {
      return request("POST", path, body);
    },
    delete(path) {
      return request("DELETE", path);
    },
  };
}
