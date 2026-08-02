import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer } from "node:http";
import { reportGate } from "../lib/report.mjs";

describe("reportGate", () => {
  let server;
  let port;
  let requests;
  let nextResponse;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(nextResponse.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(nextResponse.body));
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
    nextResponse = { status: 201, body: { id: "abc" } };
  });

  it("POSTs the gate report body with a bearer token, to the right repo path", async () => {
    const result = await reportGate({
      serverUrl: `http://127.0.0.1:${port}`,
      token: "tok",
      owner: "acme",
      repo: "widget",
      sha: "a".repeat(40),
      name: "osv-scanner",
      status: "failure",
      summary: "6 known vulnerabilities",
    });

    expect(result).toEqual({ id: "abc" });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe("/api/v3/repos/acme/widget/gates");
    expect(requests[0].headers.authorization).toBe("Bearer tok");
    expect(JSON.parse(requests[0].body)).toEqual({
      git_sha: "a".repeat(40),
      name: "osv-scanner",
      status: "failure",
      summary: "6 known vulnerabilities",
    });
  });

  it("strips a trailing slash from serverUrl", async () => {
    await reportGate({
      serverUrl: `http://127.0.0.1:${port}/`,
      token: "tok",
      owner: "acme",
      repo: "widget",
      sha: "a",
      name: "x",
      status: "success",
      summary: "",
    });
    expect(requests[0].url).toBe("/api/v3/repos/acme/widget/gates");
  });

  it("throws with the server's error message on a non-2xx response", async () => {
    nextResponse = { status: 422, body: { message: "malformed git_sha" } };
    await expect(
      reportGate({
        serverUrl: `http://127.0.0.1:${port}`,
        token: "tok",
        owner: "acme",
        repo: "widget",
        sha: "bad",
        name: "x",
        status: "success",
        summary: "",
      }),
    ).rejects.toThrow(/malformed git_sha/);
  });
});
