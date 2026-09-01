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
  // #155's commands make several calls of different shapes in one invocation —
  // `undo` looks up an operation before undoing it, `watch` reads a proposal,
  // its gates and its runs. One `nextResponse` for all of them would test a
  // server that does not exist, so a route-aware responder answers per URL and
  // `nextResponse` stays the default for everything it does not name.
  let responder: ((req: { method: string; url: string }) => { status: number; body: unknown } | undefined) | null;

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
        const chosen = responder?.({ method: req.method!, url: req.url! }) ?? nextResponse;
        res.writeHead(chosen.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(chosen.body));
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
    responder = null;
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

  // ── #155: the four verbs the native plane had no command for ────────────

  describe("watch", () => {
    const proposal = (land: unknown) => ({
      number: 4,
      title: "Add the health endpoint",
      state: "open",
      head: { ref: "feature", sha: "a".repeat(40) },
      base: { ref: "main" },
      land,
    });

    it("asks for the land verdict, which is the only thing not otherwise readable", async () => {
      responder = ({ url }) => {
        if (url.startsWith("/api/v3/repos/acme/widget/pulls/4"))
          return { status: 200, body: proposal({ allowed: true, unmet: [], unmet_detail: [], advisories: [] }) };
        return { status: 200, body: [] };
      };
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const code = await run(["watch", "--repo", "acme/widget", "--pr", "4", "--once"]);
      expect(code).toBe(0);
      // `?land=1` is the opt-in. Without it the server does not evaluate the
      // policy, and the whole reason this command exists is to read that
      // verdict without attempting the merge.
      expect(requests.some((r) => r.url === "/api/v3/repos/acme/widget/pulls/4?land=1")).toBe(true);
      expect(logSpy.mock.calls.flat().join("\n")).toContain("adp pr merge --repo acme/widget --number 4");
      logSpy.mockRestore();
    });

    // #145: a refusal that names the unmet requirement and stops there sends
    // the reader back to the documentation at the moment the product was about
    // to prove itself. The remedy and the literal command are the half that
    // helps, and a watcher that dropped them would undo that work.
    it("prints each unmet requirement with its remedy and its command", async () => {
      responder = ({ url }) => {
        if (url.startsWith("/api/v3/repos/acme/widget/pulls/4"))
          return {
            status: 200,
            body: proposal({
              allowed: false,
              unmet: ["one_approval → ask someone other than the author"],
              unmet_detail: [
                {
                  requirement: "one_approval",
                  problem: "no approving review from anyone other than the author",
                  remedy: "ask someone other than the author to approve it",
                  command: "adp pr review --repo acme/widget --number 4 --state approved",
                },
                {
                  requirement: "gates_green",
                  problem: "tests reported failure",
                  remedy: "push again with the failure fixed",
                },
              ],
              advisories: ["gate 'flaky' is quarantined"],
            }),
          };
        if (url.includes("/gates")) return { status: 200, body: [{ name: "tests", status: "failure", summary: "2 failing" }] };
        return { status: 200, body: [] };
      };
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await run(["watch", "--repo", "acme/widget", "--pr", "4", "--once"]);
      const out = logSpy.mock.calls.flat().join("\n");

      expect(out).toContain("not landable yet");
      expect(out).toContain("no approving review from anyone other than the author");
      expect(out).toContain("adp pr review --repo acme/widget --number 4 --state approved");
      // A requirement with no command must not grow an invented one: a gate
      // that ran and failed is satisfied by a new commit, and suggesting
      // `adp gate report --status success` would teach that the gate is a
      // formality.
      expect(out).toContain("push again with the failure fixed");
      expect(out).not.toContain("adp gate report");
      // An advisory did not block the land and still has to be visible: a gate
      // that silently stops mattering is worse than a flaky one.
      expect(out).toContain("quarantined");
      logSpy.mockRestore();
    });

    it("refuses an interval below a second rather than spinning", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await run(["watch", "--repo", "acme/widget", "--interval", "0"])).toBe(1);
      expect(errSpy.mock.calls.flat().join(" ")).toContain("at least 1 second");
      errSpy.mockRestore();
    });
  });

  describe("undo", () => {
    const mergeOp = { id: "op-1", verb: "proposal.merge", target: "acme/widget#3", before: {}, after: { baseSha: "b".repeat(40) }, created_at: "" };

    it("resolves the sha a person actually has to the operation the API is keyed by", async () => {
      responder = ({ url }) => {
        if (url.includes("/operations?")) return { status: 200, body: [mergeOp] };
        return { status: 200, body: { id: "op-2", verb: "proposal.merge.undo", undo_path: "rollback" } };
      };
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const code = await run(["undo", "b".repeat(40), "--repo", "acme/widget"]);
      expect(code).toBe(0);
      expect(requests[1]!.url).toBe("/api/adp/repos/acme/widget/operations/op-1/undo");
      expect(logSpy.mock.calls.flat().join("\n")).toContain("rolled back");
      logSpy.mockRestore();
    });

    it("accepts an abbreviated sha, which is what `git log` prints", async () => {
      responder = ({ url }) => {
        if (url.includes("/operations?")) return { status: 200, body: [mergeOp] };
        return { status: 200, body: { id: "op-2", verb: "proposal.merge.undo", undo_path: "rollback" } };
      };
      vi.spyOn(console, "log").mockImplementation(() => {});
      expect(await run(["undo", "b".repeat(8), "--repo", "acme/widget"])).toBe(0);
      vi.restoreAllMocks();
    });

    // #159's third done-when. These are different facts about history, and a
    // client that printed "undone" for both would be wrong half the time.
    it("says the revert path leaves the change still in the branch", async () => {
      responder = ({ url }) => {
        if (url.includes("/operations?")) return { status: 200, body: [mergeOp] };
        return {
          status: 200,
          body: {
            id: "op-2",
            verb: "proposal.merge.revert",
            undo_path: "revert",
            proposal: { number: 9, title: 'Revert "Add x" (#3)', head_ref: "adp/revert-3", head_sha: "c".repeat(40), base_ref: "main", state: "open" },
            gate_jobs_enqueued: 1,
          },
        };
      };
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await run(["undo", "b".repeat(40), "--repo", "acme/widget"]);
      const out = logSpy.mock.calls.flat().join("\n");
      expect(out).toContain("Nothing is undone yet");
      expect(out).toContain("#9 has to satisfy the land policy first");
      expect(out).toContain("adp/revert-3");
      logSpy.mockRestore();
    });

    it("names the conflicting paths rather than only that it conflicts", async () => {
      responder = ({ url }) => {
        if (url.includes("/operations?")) return { status: 200, body: [mergeOp] };
        return {
          status: 422,
          body: { message: "reverting #3 conflicts with what landed after it", conflicts: ["src/land.ts", "README.md"] },
        };
      };
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await run(["undo", "b".repeat(40), "--repo", "acme/widget"])).toBe(1);
      const out = errSpy.mock.calls.flat().join("\n");
      expect(out).toContain("src/land.ts");
      expect(out).toContain("README.md");
      errSpy.mockRestore();
    });

    it("refuses a sha no merge produced, and says why that happens", async () => {
      responder = () => ({ status: 200, body: [] });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await run(["undo", "f".repeat(40), "--repo", "acme/widget"])).toBe(1);
      // "not found" for a sha that plainly exists in `git log` is the least
      // actionable message this could produce.
      expect(errSpy.mock.calls.flat().join(" ")).toContain("pushed directly has no merge operation");
      errSpy.mockRestore();
    });
  });

  describe("bakeoff", () => {
    it("opens a candidate set and one labelled run per harness", async () => {
      responder = ({ url, method }) => {
        if (url.endsWith("/candidate-sets") && method === "POST") return { status: 201, body: { id: "set-1" } };
        if (url.endsWith("/runs") && method === "POST") return { status: 201, body: { id: `run-${requests.length}` } };
        return { status: 200, body: { runs: [] } };
      };
      vi.spyOn(console, "log").mockImplementation(() => {});
      const code = await run([
        "bakeoff", "--repo", "acme/widget", "--intent", "11111111-1111-1111-1111-111111111111",
        "--harness", "claude-code,codex",
      ]);
      expect(code).toBe(0);

      const runPosts = requests.filter((r) => r.method === "POST" && r.url.endsWith("/runs"));
      expect(runPosts).toHaveLength(2);
      // The label is what makes the comparison evidence rather than annotation:
      // it rides inside the signed run attestation.
      expect(JSON.parse(runPosts[0]!.body).labels).toEqual({ harness: "claude-code" });
      expect(JSON.parse(runPosts[1]!.body).labels).toEqual({ harness: "codex" });
      vi.restoreAllMocks();
    });

    it("refuses a single arm, which is not a comparison", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await run(["bakeoff", "--repo", "acme/widget", "--intent", "x", "--harness", "claude-code"])).toBe(1);
      expect(errSpy.mock.calls.flat().join(" ")).toContain("at least two");
      errSpy.mockRestore();
    });

    // Two runs under one label produce two rows the comparison cannot tell
    // apart, which is the one result a bakeoff must not produce.
    it("refuses a duplicated arm", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await run(["bakeoff", "--repo", "acme/widget", "--intent", "x", "--harness", "codex,codex"])).toBe(1);
      expect(errSpy.mock.calls.flat().join(" ")).toContain("duplicate");
      errSpy.mockRestore();
    });

    it("resolves #<issue> to the intent it carries", async () => {
      responder = ({ url, method }) => {
        if (url.endsWith("/issues/7")) return { status: 200, body: { number: 7, title: "t", intent_id: "int-7" } };
        if (url.endsWith("/candidate-sets") && method === "POST") return { status: 201, body: { id: "set-1" } };
        if (url.endsWith("/runs") && method === "POST") return { status: 201, body: { id: "run-1" } };
        return { status: 200, body: { runs: [] } };
      };
      vi.spyOn(console, "log").mockImplementation(() => {});
      await run(["bakeoff", "--repo", "acme/widget", "--intent", "#7", "--harness", "a,b"]);
      expect(JSON.parse(requests[1]!.body).intent_id).toBe("int-7");
      vi.restoreAllMocks();
    });
  });

  describe("runner up", () => {
    // The host decision is the whole reason this command exists rather than a
    // documented pair of environment variables.
    it("refuses without --here, and says that a mounted socket is root on this host", async () => {
      process.env.ADP_RUNNER_TOKEN = "runner-token";
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await run(["runner", "up"])).toBe(1);
      const out = errSpy.mock.calls.flat().join(" ");
      expect(out).toContain("root on this host");
      expect(out).toContain("--here");
      errSpy.mockRestore();
      delete process.env.ADP_RUNNER_TOKEN;
    });

    // The runner gets a token scoped to `runner` and nothing else. Falling back
    // to the developer's login token would work, and would hand the process
    // most likely to be executing something hostile a credential that can write
    // to every repository they can.
    it("refuses to fall back to the login token", async () => {
      delete process.env.ADP_RUNNER_TOKEN;
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await run(["runner", "up", "--here"])).toBe(1);
      const out = errSpy.mock.calls.flat().join(" ");
      expect(out).toContain("ADP_RUNNER_TOKEN");
      expect(out).toContain("do not reuse your own login token");
      errSpy.mockRestore();
    });
  });

  describe("pr review", () => {
    it("posts the review and points at what decides whether it counts", async () => {
      nextResponse = { status: 201, body: { id: "r1", state: "approved" } };
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      expect(await run(["pr", "review", "--repo", "acme/widget", "--number", "4", "--state", "approved"])).toBe(0);
      expect(requests[0]!.url).toBe("/api/v3/repos/acme/widget/pulls/4/reviews");
      expect(JSON.parse(requests[0]!.body).state).toBe("approved");
      // #121: recorded is not the same as satisfying — an approval by the
      // author does not count toward `one_approval`.
      expect(logSpy.mock.calls.flat().join("\n")).toContain("adp watch");
      logSpy.mockRestore();
    });

    it("refuses a state the server would reject", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await run(["pr", "review", "--repo", "acme/widget", "--number", "4", "--state", "lgtm"])).toBe(1);
      expect(errSpy.mock.calls.flat().join(" ")).toContain("--state must be one of");
      errSpy.mockRestore();
      expect(requests).toHaveLength(0);
    });
  });
});
