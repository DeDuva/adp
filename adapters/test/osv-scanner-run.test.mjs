import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../osv-scanner/run.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

// End-to-end for the adapter's own CLI entrypoint, using the real JSON
// fixture captured from a live `osv-scanner --format json` run.
describe("osv-scanner adapter CLI", () => {
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

  it("reads a real osv-scanner JSON fixture and reports failure with the right verdict", async () => {
    await main([
      "--json",
      path.join(FIXTURES, "osv-scanner-real.json"),
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
    expect(body.name).toBe("osv-scanner");
    expect(body.status).toBe("failure");
    expect(body.summary).toContain("lodash@4.17.15");
  });

  it("reports success for a real clean-scan fixture", async () => {
    await main([
      "--json",
      path.join(FIXTURES, "osv-scanner-clean-real.json"),
      "--repo",
      "acme/widget",
      "--sha",
      "a".repeat(40),
      "--server",
      `http://127.0.0.1:${port}`,
      "--token",
      "tok",
    ]);
    expect(JSON.parse(requests[0].body).status).toBe("success");
  });

  it("throws a usage error without --json or --repo", async () => {
    await expect(main(["--repo", "acme/widget"], { ADP_SERVER_URL: `http://127.0.0.1:${port}`, ADP_TOKEN: "tok" })).rejects.toThrow(
      /usage/,
    );
    expect(requests).toHaveLength(0);
  });
});
