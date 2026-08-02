import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../wizcli/run.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

// End-to-end for the adapter's own CLI entrypoint: real SARIF fixture on
// disk (the same file captured from a real osv-scanner --format sarif run,
// reused here since a genuine wizcli-produced SARIF file isn't obtainable
// without a Wiz license — SARIF is SARIF regardless of which scanner wrote
// it) -> real local HTTP server standing in for ADP.
describe("wizcli adapter CLI", () => {
  let server;
  let port;
  let requests;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        requests.push({ url: req.url, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    requests = [];
  });

  it("reads a SARIF fixture, reports failure at the default (warning) level, with an explicit sha", async () => {
    await main([
      "--sarif",
      path.join(FIXTURES, "osv-scanner-real.sarif"),
      "--repo",
      "acme/widget",
      "--sha",
      "a".repeat(40),
      "--server",
      `http://127.0.0.1:${port}`,
      "--token",
      "tok",
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/api/v3/repos/acme/widget/gates");
    const body = JSON.parse(requests[0].body);
    expect(body.git_sha).toBe("a".repeat(40));
    expect(body.name).toBe("wizcli");
    expect(body.status).toBe("failure");
  });

  it("respects --fail-level error, passing the same fixture", async () => {
    await main([
      "--sarif",
      path.join(FIXTURES, "osv-scanner-real.sarif"),
      "--repo",
      "acme/widget",
      "--sha",
      "a".repeat(40),
      "--server",
      `http://127.0.0.1:${port}`,
      "--token",
      "tok",
      "--fail-level",
      "error",
    ]);
    expect(JSON.parse(requests[0].body).status).toBe("success");
  });

  it("respects --gate-name", async () => {
    await main([
      "--sarif",
      path.join(FIXTURES, "sarif-clean.sarif"),
      "--repo",
      "acme/widget",
      "--sha",
      "a".repeat(40),
      "--server",
      `http://127.0.0.1:${port}`,
      "--token",
      "tok",
      "--gate-name",
      "wiz-iac",
    ]);
    expect(JSON.parse(requests[0].body).name).toBe("wiz-iac");
  });

  it("throws a usage error without --sarif or --repo, making no request", async () => {
    await expect(main(["--repo", "acme/widget"], { ADP_SERVER_URL: `http://127.0.0.1:${port}`, ADP_TOKEN: "tok" })).rejects.toThrow(
      /usage/,
    );
    expect(requests).toHaveLength(0);
  });

  it("throws without a server/token, from flags or env", async () => {
    await expect(
      main(["--sarif", path.join(FIXTURES, "sarif-clean.sarif"), "--repo", "acme/widget"], {}),
    ).rejects.toThrow(/server URL and token required/);
  });

  it("falls back to ADP_SERVER_URL/ADP_TOKEN when flags are omitted", async () => {
    await main(["--sarif", path.join(FIXTURES, "sarif-clean.sarif"), "--repo", "acme/widget", "--sha", "a".repeat(40)], {
      ADP_SERVER_URL: `http://127.0.0.1:${port}`,
      ADP_TOKEN: "tok",
    });
    expect(requests).toHaveLength(1);
  });
});
