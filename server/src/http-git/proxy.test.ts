import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { GitBackend } from "../core/git-backend.js";
import { registerGitHttpRoutes } from "./proxy.js";

const execFileAsync = promisify(execFile);

// Full clone/push roundtrip through Fastify -> git http-backend, with auth
// stubbed to a fixed identity so this suite doesn't need Postgres. The auth
// *middleware* itself is covered separately (it's a thin DB lookup); this
// suite is about wire-protocol fidelity, which is the highest-risk piece of
// the compat plane (docs/pragmatic_mvp.md §2.4 Tier 1).
describe("git smart-HTTP proxy", () => {
  let gitRoot: string;
  let workDir: string;
  let app: FastifyInstance;
  let port: number;
  let backend: GitBackend;

  beforeAll(async () => {
    gitRoot = await mkdtemp(path.join(tmpdir(), "adp-proxy-test-git-"));
    backend = new GitBackend(gitRoot);
    await backend.initBareRepo("acme", "hello", "main");

    app = Fastify({ logger: false });
    app.addContentTypeParser(
      ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body as Buffer),
    );
    app.addHook("onRequest", async (req) => {
      req.identity = { identityId: "test", kind: "human", principal: "tester", scopes: ["repo:write"] };
    });
    registerGitHttpRoutes(app, backend);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;
  });

  afterAll(async () => {
    await app.close();
    await rm(gitRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "adp-proxy-test-clone-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("returns 404 for a repo that doesn't exist", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/acme/nope.git/info/refs?service=git-upload-pack`);
    expect(res.status).toBe(404);
  });

  it("clones an empty repo and accepts a push, and the commit lands server-side", async () => {
    const cloneDir = path.join(workDir, "clone");
    await execFileAsync("git", ["clone", `http://127.0.0.1:${port}/acme/hello.git`, cloneDir]);

    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    await execFileAsync("sh", ["-c", "echo hi > README.md"], { cwd: cloneDir });
    await execFileAsync("git", ["add", "."], { cwd: cloneDir });
    await execFileAsync("git", ["commit", "-m", "test commit"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });

    const { stdout } = await execFileAsync("git", ["log", "--oneline", "main"], {
      cwd: backend.repoPath("acme", "hello"),
    });
    expect(stdout).toContain("test commit");
  });
});
