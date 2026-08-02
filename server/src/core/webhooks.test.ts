import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { signPayload, emitWebhookEvent, type WebhookLogger } from "./webhooks.js";

function nullLogger(): WebhookLogger {
  return { warn: vi.fn(), error: vi.fn() };
}

describe("signPayload", () => {
  it("matches GitHub's X-Hub-Signature-256 shape (sha256=<hex hmac>)", () => {
    const body = '{"a":1}';
    const sig = signPayload("s3cr3t", body);
    const expected = `sha256=${createHmac("sha256", "s3cr3t").update(body).digest("hex")}`;
    expect(sig).toBe(expected);
  });

  it("changes when the secret changes", () => {
    expect(signPayload("a", "body")).not.toBe(signPayload("b", "body"));
  });
});

describe("emitWebhookEvent", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("delivers only to active hooks subscribed to the fired event type", async () => {
    const calls: { url: string }[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      calls.push({ url: String(url) });
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const db = {
      select: () => ({
        from: () => ({
          where: async () => [
            { targetUrl: "http://sub-a.example/hook", secret: "s", events: ["push"], active: true },
            { targetUrl: "http://sub-b.example/hook", secret: "s", events: ["pull_request"], active: true },
            { targetUrl: "http://sub-c.example/hook", secret: "s", events: ["push"], active: true },
          ],
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    emitWebhookEvent(db, "repo-1", "push", { hello: "world" }, nullLogger());
    // emitWebhookEvent is fire-and-forget — give its internal promise chain a tick.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls.map((c) => c.url).sort()).toEqual(["http://sub-a.example/hook", "http://sub-c.example/hook"]);
  });

  it("retries a failing delivery and eventually logs instead of throwing", async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn(async () => {
      attempts++;
      return new Response(null, { status: 500 });
    }) as typeof fetch;

    const logger = nullLogger();
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [{ targetUrl: "http://flaky.example/hook", secret: "s", events: ["push"], active: true }],
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    emitWebhookEvent(db, "repo-1", "push", {}, logger);
    // 3 attempts with 1s/2s backoff between them — wait past the last backoff.
    await new Promise((resolve) => setTimeout(resolve, 3500));

    expect(attempts).toBe(3);
    expect(logger.error).toHaveBeenCalledOnce();
  }, 10_000);
});
