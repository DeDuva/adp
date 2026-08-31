import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { identities, sessions } from "../src/db/schema.js";
import { mintToken } from "../src/auth/tokens.js";
import { grantOwner } from "./org-fixture.js";
import { authPlugin } from "../src/auth/plugin.js";
import { GitBackend } from "../src/core/git-backend.js";
import { Signer } from "../src/core/signing.js";
import { registerRepoRoutes } from "../src/http-rest/repos.js";
import { registerTokenRoutes } from "../src/http-rest/tokens.js";
import { registerSessionRoutes } from "../src/http-rest/sessions.js";
import { registerIdentityRoutes } from "../src/http-rest/identity.js";

const execFileAsync = promisify(execFile);
const SIGNING_KEY = "e2e-connect-signing-key";
const PUBLIC_URL = "https://adp.example.com";

// The CLI as a *process*, and against a real server — because what #154 is
// about is the gap between "wrote some files" and "it works". A unit test over
// the config writers proves the first; only this proves the second, and the
// issue's whole point is that a config written to the wrong path fails silently
// and looks identical to success.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI_MAIN = path.join(REPO_ROOT, "cli", "dist", "index.js");

describe.skipIf(skipWithoutDb)("#154: adp connect, against a live ADP", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: import("pg").Pool;
  let gitRoot: string;
  let port: number;
  let adminToken: string;
  let readOnlyToken: string;
  let configDir: string;
  const owner = `connect-owner-${Date.now()}`;
  const repoName = "widget";

  /** Run the CLI in `cwd`, with a config directory of its own. */
  function adp(args: string[], cwd: string, env: Record<string, string> = {}) {
    return execFileAsync(process.execPath, [CLI_MAIN, ...args], {
      cwd,
      env: {
        ...process.env,
        ADP_CONFIG_DIR: configDir,
        ADP_SERVER_URL: `http://127.0.0.1:${port}`,
        ADP_TOKEN: adminToken,
        ...env,
      },
    });
  }

  /**
   * Every temp directory this file makes, removed in `afterAll`.
   *
   * Not at the end of each test: a `rm` in the test body is skipped whenever an
   * assertion above it throws, so the runs that leak are exactly the runs that
   * failed — and `scripts/dev/verify-clean.sh` then warns about stale
   * directories on top of the failure that caused them.
   */
  const scratch: string[] = [];
  async function scratchDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    scratch.push(dir);
    return dir;
  }

  /** A checkout whose remote points at this ADP, which is how connect finds the repository. */
  async function checkout(): Promise<string> {
    const dir = await scratchDir("adp-e2e-connect-work-");
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    await execFileAsync("git", ["remote", "add", "origin", `http://127.0.0.1:${port}/${owner}/${repoName}.git`], {
      cwd: dir,
    });
    return dir;
  }

  beforeAll(async () => {
    // Both built here rather than relied on: `make test-all` runs the server
    // suite before `make cli` and `make recorder`, so a dist from a previous
    // run — or none at all — is what this would otherwise find, and connect
    // reports "no built recorder" instead of wiring recording.
    await execFileAsync("npm", ["run", "build", "--prefix", path.join(REPO_ROOT, "cli")], { cwd: REPO_ROOT });
    await execFileAsync("npm", ["run", "build", "--prefix", path.join(REPO_ROOT, "recorder")], { cwd: REPO_ROOT });

    ({ db, pool } = createDb(process.env.DATABASE_URL!));
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

    gitRoot = await scratchDir("adp-e2e-connect-git-");
    const gitBackend = new GitBackend(gitRoot);
    const signer = new Signer(SIGNING_KEY);

    app = Fastify({ logger: false });
    await app.register(authPlugin(db));
    registerRepoRoutes(app, db, gitBackend, PUBLIC_URL);
    registerIdentityRoutes(app, PUBLIC_URL);
    registerTokenRoutes(app, db);
    registerSessionRoutes(app, db, gitBackend, signer, PUBLIC_URL);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    const [admin] = await db
      .insert(identities)
      .values({ kind: "human", principal: `connect-admin-${Date.now()}` })
      .returning();
    adminToken = await mintToken(db, admin!.id, ["repo:read", "repo:write", "admin"]);
    await grantOwner(db, admin!.id, owner);
    readOnlyToken = await mintToken(db, admin!.id, ["repo:read", "repo:write"]);

    const created = await fetch(`http://127.0.0.1:${port}/api/v3/repos/${owner}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: repoName }),
    });
    if (!created.ok) throw new Error(`fixture: could not create the repo — HTTP ${created.status} ${await created.text()}`);

    configDir = await scratchDir("adp-e2e-connect-config-");
  }, 180_000);

  afterAll(async () => {
    // Optional chaining, because `beforeAll` can fail before these exist — and
    // when it does, an `afterAll` that throws its own TypeError is what gets
    // reported. That is exactly how a missing dependency tree in CI surfaced
    // as "cannot read properties of undefined (reading 'close')" rather than
    // as the build error it actually was.
    await app?.close();
    await pool?.end();
    for (const dir of scratch) await rm(dir, { recursive: true, force: true });
  });

  it("connects a harness and proves it with a real session", async () => {
    // #154's central requirement, and the one that separates a setup command
    // from a setup command anyone trusts: connect finishes by opening and
    // closing a session with the credential it just wrote.
    const work = await checkout();
    const { stdout } = await adp(["connect", "claude-code"], work);
    expect(stdout).toContain(`connected claude-code`);
    expect(stdout).toMatch(/verified with a real session/);

    // Not the CLI's word for it — the session is in the database, closed.
    const id = /session \(([0-9a-f-]{36})\)/.exec(stdout)![1]!;
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
    expect(row!.harness).toBe("claude-code");
    expect(row!.status).toBe("closed");

    // And the config it wrote points at a real MCP server with a real token.
    const mcp = JSON.parse(readFileSync(path.join(work, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.adp.env.ADP_SERVER_URL).toBe(`http://127.0.0.1:${port}`);
    expect(mcp.mcpServers.adp.env.ADP_TOKEN).toBeTruthy();
    expect(existsSync(mcp.mcpServers.adp.args[0])).toBe(true);

    // Recording is wired to a recorder that exists, and the launcher can be
    // run. Claude Code is the one harness that can start it by itself: a
    // SessionStart hook is handed the transcript path, which is what `tail`
    // follows — so the launcher's job is to find it on stdin.
    const launcher = path.join(work, ".adp", "record-claude-code");
    expect(existsSync(launcher)).toBe(true);
    expect(statSync(launcher).mode & 0o111).toBeTruthy();
    const body = readFileSync(launcher, "utf8");
    expect(body).toContain(path.join("recorder", "dist", "main.js"));
    expect(body).toContain("transcript_path");
    expect(body).toContain(`--repo '${owner}/${repoName}'`);

  }, 180_000);

  it("mints the harness its own token, carrying what the token can say", async () => {
    // #141 made a token able to name its harness and model; nothing was
    // setting them. The credential the harness ends up holding is not the
    // developer's own.
    const work = await checkout();
    await adp(["connect", "codex", "--model", "gpt-5-codex"], work);
    const toml = readFileSync(path.join(work, ".codex", "config.toml"), "utf8");
    const token = /ADP_TOKEN = "([^"]+)"/.exec(toml)![1]!;
    expect(token).not.toBe(adminToken);

    // The token authenticates, and it is not an admin one.
    const asHarness = async (p: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${port}${p}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
      });
    const session = await asHarness(`/api/adp/repos/${owner}/${repoName}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "codex" }),
    });
    expect(session.status).toBe(201);
    const escalate = await asHarness("/api/adp/tokens", {
      method: "POST",
      body: JSON.stringify({ principal: "x", scopes: ["repo:read"] }),
    });
    expect(escalate.status).toBe(403);

  }, 180_000);

  it("connects with a token that cannot mint, and says which half it did not get", async () => {
    // Someone evaluating ADP alone holds a repo token, not an admin one.
    // Refusing the whole connect over the half that needs `admin` would fail
    // the person the phase exists for.
    const work = await checkout();
    const { stdout } = await adp(["connect", "gemini-cli"], work, { ADP_TOKEN: readOnlyToken });
    expect(stdout).toContain("reused the logged-in token");
    expect(stdout).toMatch(/verified with a real session/);
  }, 180_000);

  it("keeps the credential it wrote out of commits", async () => {
    // A harness reads its MCP configuration from a file in the repository, and
    // that file has to carry the token for the harness to authenticate — so
    // connect puts a live credential in the working tree and the next
    // `git add -A` would publish it.
    const work = await checkout();
    await adp(["connect", "claude-code"], work);
    const status = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: work });
    expect(status.stdout).not.toContain(".mcp.json");
    expect(status.stdout).not.toContain(".adp/");
    // `info/exclude` rather than `.gitignore`: a `.gitignore` entry is itself a
    // commit, and telling every contributor about one developer's harness is
    // not connect's business.
    expect(readFileSync(path.join(work, ".git", "info", "exclude"), "utf8")).toContain("/.mcp.json");

    await adp(["disconnect", "claude-code"], work);
    expect(readFileSync(path.join(work, ".git", "info", "exclude"), "utf8")).not.toContain("/.mcp.json");
  }, 180_000);

  it("is idempotent, and repairs rather than duplicates", async () => {
    const work = await checkout();
    await adp(["connect", "claude-code"], work);
    await adp(["connect", "claude-code"], work);
    const mcp = JSON.parse(readFileSync(path.join(work, ".mcp.json"), "utf8"));
    expect(Object.keys(mcp.mcpServers)).toEqual(["adp"]);
    const hook = readFileSync(path.join(work, ".git", "hooks", "prepare-commit-msg"), "utf8");
    expect(hook.match(/adp connect/g)!.length).toBe(1);
  }, 180_000);

  it("disconnects in one command and leaves nothing behind", async () => {
    const work = await checkout();
    await adp(["connect", "claude-code"], work);
    const { stdout } = await adp(["disconnect", "claude-code"], work);
    expect(stdout).toContain("disconnected claude-code");
    expect(existsSync(path.join(work, ".mcp.json"))).toBe(false);
    expect(existsSync(path.join(work, ".git", "hooks", "prepare-commit-msg"))).toBe(false);
    expect(existsSync(path.join(work, ".adp", "record-claude-code"))).toBe(false);
  }, 180_000);

  it("refuses outside a repository, and where no remote names this server", async () => {
    // Both failures are silent-in-the-wrong-place otherwise: connect would
    // write a config nothing reads, or connect a checkout of somebody else's
    // forge and report success.
    const nowhere = await scratchDir("adp-e2e-connect-nogit-");
    await expect(adp(["connect", "claude-code"], nowhere)).rejects.toMatchObject({
      stderr: expect.stringContaining("git repository"),
    });

    const elsewhere = await scratchDir("adp-e2e-connect-other-");
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: elsewhere });
    await execFileAsync("git", ["remote", "add", "origin", "https://github.com/acme/widget.git"], { cwd: elsewhere });
    await expect(adp(["connect", "claude-code"], elsewhere)).rejects.toMatchObject({
      stderr: expect.stringContaining("no git remote points at"),
    });

  }, 180_000);

  it("fails loudly when the configuration it wrote does not work", async () => {
    // The round trip is the point: a repository the token cannot see is
    // exactly the failure a health check would pass.
    const work = await scratchDir("adp-e2e-connect-missing-");
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: work });
    await execFileAsync("git", ["remote", "add", "origin", `http://127.0.0.1:${port}/${owner}/nonexistent.git`], {
      cwd: work,
    });
    await expect(adp(["connect", "claude-code"], work)).rejects.toMatchObject({
      stderr: expect.stringContaining("it does not work"),
    });
  }, 180_000);
});
