import { loadConfig } from "./config.js";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    // #155: the parsed body, not only its `message`. ADP's refusals are
    // structured on purpose — a land refusal carries `unmet` with a remedy and
    // often a literal command (#145), and a conflicting undo carries the paths
    // it conflicts in (#159) — and a client that keeps only the message throws
    // away the half that tells a user what to do next.
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

// A thin wrapper, deliberately — every command is one REST call against the
// same server this repo already ships (server/src/http-rest/*), reusing its
// bearer-token auth. No GraphQL client: the REST surface covers everything
// this CLI's commands need, and staying on one transport keeps this file
// small.
export async function apiRequest<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
  const config = await loadConfig();
  const res = await fetch(`${config.serverUrl}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    const message =
      parsed && typeof parsed === "object" && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : `request failed with status ${res.status}`;
    throw new ApiError(message, res.status, parsed);
  }

  return parsed as T;
}
