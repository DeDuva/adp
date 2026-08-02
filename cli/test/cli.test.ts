import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../src/index.js";

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

// The CLI's own tests stand up a real local HTTP server rather than mocking
// `fetch` — this exercises the actual request the CLI sends (method, path,
// headers, body) over a real socket, the same testing boundary
// e2e-webhooks.test.ts uses on the server side. It's a fake ADP server, not
// the real one, so a request shape here can still drift from what the real
// endpoint actually requires (server/acceptance/run.sh's M2 section runs
// this CLI against a live server, which is what caught `repo mirror`
// shipping without `--credential` and with the wrong `direction` vocabulary).
describe("adp CLI", () => {
  let server: Server;
  let port: number;
  let requests: RecordedRequest[];
  let nextResponse: { status: number; body: unknown };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        requests.push({
          method: req.method!,
          url: req.url!,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(nextResponse.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(nextResponse.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = [];
    nextResponse = { status: 200, body: {} };
    process.env.ADP_SERVER_URL = `http://127.0.0.1:${port}`;
    process.env.ADP_TOKEN = "test-token";
  });

  it("pr list sends a GET with the bearer token and prints the JSON response", async () => {
    nextResponse = { status: 200, body: [{ number: 1, title: "Add feature" }] };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await run(["pr", "list", "--repo", "acme/widget"]);

    expect(code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.url).toBe("/api/v3/repos/acme/widget/pulls");
    expect(requests[0]!.headers.authorization).toBe("Bearer test-token");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Add feature"));
    logSpy.mockRestore();
  });

  it("pr merge PUTs merge_method, defaulting to 'merge'", async () => {
    const code = await run(["pr", "merge", "--repo", "acme/widget", "--number", "3"]);
    expect(code).toBe(0);
    expect(requests[0]!.method).toBe("PUT");
    expect(requests[0]!.url).toBe("/api/v3/repos/acme/widget/pulls/3/merge");
    expect(JSON.parse(requests[0]!.body)).toEqual({ merge_method: "merge" });
  });

  it("pr merge honors --method squash", async () => {
    await run(["pr", "merge", "--repo", "acme/widget", "--number", "3", "--method", "squash"]);
    expect(JSON.parse(requests[0]!.body)).toEqual({ merge_method: "squash" });
  });

  it("gate report POSTs the report body", async () => {
    const code = await run([
      "gate",
      "report",
      "--repo",
      "acme/widget",
      "--sha",
      "a".repeat(40),
      "--name",
      "test",
      "--status",
      "success",
      "--summary",
      "12 passed",
    ]);
    expect(code).toBe(0);
    expect(requests[0]!.url).toBe(`/api/v3/repos/acme/widget/gates`);
    expect(JSON.parse(requests[0]!.body)).toEqual({
      git_sha: "a".repeat(40),
      name: "test",
      status: "success",
      summary: "12 passed",
    });
  });

  it("repo mirror POSTs remote_url, webhook_secret, credential, and direction", async () => {
    const code = await run([
      "repo",
      "mirror",
      "acme/widget",
      "--remote-url",
      "https://github.com/acme/widget.git",
      "--secret",
      "whsec",
      "--credential",
      "ghp_faketoken",
      "--direction",
      "inbound",
    ]);
    expect(code).toBe(0);
    expect(requests[0]!.url).toBe("/api/v3/repos/acme/widget/mirror");
    expect(JSON.parse(requests[0]!.body)).toEqual({
      remote_url: "https://github.com/acme/widget.git",
      webhook_secret: "whsec",
      credential: "ghp_faketoken",
      direction: "inbound",
    });
  });

  it("prints an error and returns exit code 1 on a non-2xx response", async () => {
    nextResponse = { status: 422, body: { message: "Land policy not satisfied" } };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await run(["pr", "merge", "--repo", "acme/widget", "--number", "1"]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Land policy not satisfied"));
    errSpy.mockRestore();
  });

  it("prints usage and exits 1 for an unknown command, exits 0 for no command", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await run(["bogus"])).toBe(1);
    expect(await run([])).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    logSpy.mockRestore();
  });

  it("rejects a malformed --repo before ever making a request", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await run(["pr", "list", "--repo", "not-owner-slash-repo"]);
    expect(code).toBe(1);
    expect(requests).toHaveLength(0);
    errSpy.mockRestore();
  });

  describe("login", () => {
    let configDir: string;

    beforeEach(async () => {
      configDir = await mkdtemp(path.join(tmpdir(), "adp-cli-login-"));
      process.env.ADP_CONFIG_DIR = configDir;
      delete process.env.ADP_SERVER_URL;
      delete process.env.ADP_TOKEN;
    });

    afterEach(async () => {
      delete process.env.ADP_CONFIG_DIR;
      await rm(configDir, { recursive: true, force: true });
    });

    it("writes server and token to the config file, without hitting the network", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const code = await run(["login", "--server", "http://localhost:3000/", "--token", "tok123"]);
      expect(code).toBe(0);
      expect(requests).toHaveLength(0);

      const raw = await readFile(path.join(configDir, "config.json"), "utf8");
      // Trailing slash stripped, same shape a server URL is used in everywhere else.
      expect(JSON.parse(raw)).toEqual({ serverUrl: "http://localhost:3000", token: "tok123" });
      logSpy.mockRestore();
    });
  });
});
