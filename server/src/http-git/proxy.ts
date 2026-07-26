import { spawn } from "node:child_process";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { GitBackend } from "../core/git-backend.js";

// Delegates the smart-HTTP wire protocol to the real `git http-backend` CGI.
// This is the reference implementation, already installed, and gives perfect
// protocol fidelity for free — the single highest-value compatibility decision
// in the MVP.
function runHttpBackend(opts: {
  repoRoot: string;
  pathInfo: string;
  method: string;
  queryString: string;
  contentType: string;
  remoteUser: string;
  body: Buffer;
}): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: opts.repoRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: opts.pathInfo,
        REQUEST_METHOD: opts.method,
        QUERY_STRING: opts.queryString,
        CONTENT_TYPE: opts.contentType,
        CONTENT_LENGTH: String(opts.body.length),
        REMOTE_USER: opts.remoteUser,
        REMOTE_ADDR: "127.0.0.1",
        SERVER_PROTOCOL: "HTTP/1.1",
      },
    });

    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => (stderr += c.toString()));

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`git http-backend exited ${code}: ${stderr}`));
        return;
      }
      const raw = Buffer.concat(chunks);
      const headerEnd = raw.indexOf("\r\n\r\n");
      const sepLen = 4;
      const rawHeaders = (headerEnd === -1 ? raw.toString("latin1") : raw.slice(0, headerEnd).toString("latin1"));
      const body = headerEnd === -1 ? Buffer.alloc(0) : raw.slice(headerEnd + sepLen);

      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of rawHeaders.split("\r\n")) {
        if (!line) continue;
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key.toLowerCase() === "status") {
          status = parseInt(value.split(" ")[0] ?? "200", 10);
        } else {
          headers[key] = value;
        }
      }
      resolve({ status, headers, body });
    });

    child.stdin.write(opts.body);
    child.stdin.end();
  });
}

export function registerGitHttpRoutes(app: FastifyInstance, gitBackend: GitBackend) {
  app.route({
    method: ["GET", "POST"],
    url: "/:owner/:repo.git/*",
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const { owner, repo } = req.params as { owner: string; repo: string };

      if (!(await gitBackend.exists(owner, repo))) {
        reply.code(404).send({ message: `Repository ${owner}/${repo} not found` });
        return;
      }

      // git push requires write auth; clone/fetch is readable by anyone with a token.
      if (!req.identity) {
        reply.code(401).header("WWW-Authenticate", "Basic realm=adp").send();
        return;
      }

      const wildcard = (req.params as Record<string, string>)["*"] ?? "";
      const url = new URL(req.url, "http://internal");

      const result = await runHttpBackend({
        repoRoot: gitBackend.repoPath(owner, repo).replace(new RegExp(`${repo}\\.git$`), ""),
        pathInfo: `/${repo}.git/${wildcard}`,
        method: req.method,
        queryString: url.search.replace(/^\?/, ""),
        contentType: req.headers["content-type"] ?? "",
        remoteUser: req.identity.principal,
        body: (req.body as Buffer | undefined) ?? Buffer.alloc(0),
      });

      reply.code(result.status);
      for (const [key, value] of Object.entries(result.headers)) {
        reply.header(key, value);
      }
      reply.send(result.body);
    },
  });
}
