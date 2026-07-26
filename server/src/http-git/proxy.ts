import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { GitBackend } from "../core/git-backend.js";
import { hasScope } from "../auth/plugin.js";

// receive-pack (push) needs repo:write; upload-pack (clone/fetch) only needs
// repo:read — both the `/info/refs?service=` negotiation GET and the
// `/git-<service>-pack` POST carry this in the URL.
function isWriteRequest(wildcard: string, queryString: string): boolean {
  return wildcard.endsWith("git-receive-pack") || queryString.includes("service=git-receive-pack");
}

class BodyTooLargeError extends Error {}

// Enforced independently of Fastify's own bodyLimit/Content-Length check:
// this also catches a chunked-encoded request with no declared length.
function limitBytes(maxBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, callback) {
      seen += chunk.length;
      if (seen > maxBytes) {
        callback(new BodyTooLargeError(`request body exceeds ${maxBytes} bytes`));
        return;
      }
      callback(null, chunk);
    },
  });
}

// Splits a CGI response stream into its header block and body without
// buffering the body — headers are a few hundred bytes, git pack bodies can
// be gigabytes. `onHeaders` fires once, as soon as the blank line after the
// header block is seen; every chunk after that point is forwarded through
// this Transform's normal push/output path as the body.
function splitCgiResponse(onHeaders: (status: number, headers: Record<string, string>) => void): Transform {
  let headerBuf = Buffer.alloc(0);
  let headersSent = false;

  return new Transform({
    transform(chunk, _enc, callback) {
      if (headersSent) {
        callback(null, chunk);
        return;
      }

      headerBuf = Buffer.concat([headerBuf, chunk]);
      const sepIdx = headerBuf.indexOf("\r\n\r\n");
      if (sepIdx === -1) {
        // Bound how long we'll wait for the header block, in case a
        // misbehaving CGI process never sends one — 64 KiB is generous for
        // real header sets.
        if (headerBuf.length > 64 * 1024) {
          callback(new Error("git http-backend: header block exceeded 64 KiB"));
        } else {
          callback();
        }
        return;
      }

      const rawHeaders = headerBuf.slice(0, sepIdx).toString("latin1");
      const rest = headerBuf.subarray(sepIdx + 4);
      headersSent = true;

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
      onHeaders(status, headers);
      callback(null, rest.length > 0 ? rest : undefined);
    },
  });
}

// Delegates the smart-HTTP wire protocol to the real `git http-backend` CGI.
// This is the reference implementation, already installed, and gives perfect
// protocol fidelity for free — the single highest-value compatibility decision
// in the MVP. Both directions are streamed through: neither the request pack
// nor the response pack is ever fully buffered in memory (docs/pragmatic_mvp.md
// §1.5 — "any real-sized pack 413s ... currently fully buffered").
function streamHttpBackend(
  opts: {
    repoRoot: string;
    pathInfo: string;
    method: string;
    queryString: string;
    contentType: string;
    contentLength: string | undefined;
    remoteUser: string;
    body: Readable;
    maxBytes: number;
  },
  reply: FastifyReply,
): Promise<void> {
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
        CONTENT_LENGTH: opts.contentLength ?? "",
        REMOTE_USER: opts.remoteUser,
        REMOTE_ADDR: "127.0.0.1",
        SERVER_PROTOCOL: "HTTP/1.1",
      },
    });

    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);

    // Both the request-side guard and the response-side header parser can
    // try to produce the HTTP response independently (a too-large upload can
    // fire *after* http-backend has already started writing an error of its
    // own to stdout) — only one may ever call reply.hijack()/writeHead/send,
    // and once one has, the other side's pipeline must stop producing output
    // rather than write to an already-finished response.
    let responded = false;
    const responseSplitter = splitCgiResponse((status, headers) => {
      if (responded) return;
      responded = true;
      reply.hijack();
      reply.raw.writeHead(status, headers);
    });

    const guard = limitBytes(opts.maxBytes);
    guard.on("error", (err) => {
      child.kill();
      child.stdout.unpipe(responseSplitter);
      responseSplitter.unpipe(reply.raw);
      responseSplitter.destroy();
      if (err instanceof BodyTooLargeError && !responded) {
        responded = true;
        reply.code(413).send({ message: err.message });
        resolve();
        return;
      }
      if (!responded) reject(err);
    });
    opts.body.pipe(guard).pipe(child.stdin);

    let settled = false;
    child.stdout.pipe(responseSplitter).pipe(reply.raw);

    responseSplitter.on("error", (err) => {
      if (!settled) {
        settled = true;
        if (!responded) reject(err);
      }
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0 && code !== null && !responded) {
        reject(new Error(`git http-backend exited ${code}: ${stderr}`));
        return;
      }
      resolve();
    });
  });
}

export function registerGitHttpRoutes(app: FastifyInstance, gitBackend: GitBackend, maxBytes = 500 * 1024 * 1024) {
  app.route({
    method: ["GET", "POST"],
    url: "/:owner/:repo.git/*",
    // Bypasses Fastify's body parsing entirely (config.contentTypeParser is
    // never invoked for a route with no matching parser needed here) — the
    // raw request stream is read directly in the handler below via req.raw.
    bodyLimit: maxBytes,
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const { owner, repo } = req.params as { owner: string; repo: string };

      if (!(await gitBackend.exists(owner, repo))) {
        reply.code(404).send({ message: `Repository ${owner}/${repo} not found` });
        return;
      }

      if (!req.identity) {
        reply.code(401).header("WWW-Authenticate", "Basic realm=adp").send();
        return;
      }

      const wildcard = (req.params as Record<string, string>)["*"] ?? "";
      const url = new URL(req.url, "http://internal");
      const requiredScope = isWriteRequest(wildcard, url.search) ? "repo:write" : "repo:read";
      if (!hasScope(req.identity.scopes, requiredScope)) {
        reply.code(403).send({ message: `Requires scope '${requiredScope}'` });
        return;
      }

      await streamHttpBackend(
        {
          repoRoot: gitBackend.repoPath(owner, repo).replace(new RegExp(`${repo}\\.git$`), ""),
          pathInfo: `/${repo}.git/${wildcard}`,
          method: req.method,
          queryString: url.search.replace(/^\?/, ""),
          contentType: req.headers["content-type"] ?? "",
          contentLength: req.headers["content-length"],
          // Pushed through as REMOTE_USER, which git forwards verbatim to
          // any hooks it spawns (http-git/hooks.ts) — the identity's id,
          // not its display name, since the hooks need to look the
          // identity back up unambiguously (principal isn't unique).
          remoteUser: req.identity.identityId,
          body: (req.body as Readable | undefined) ?? req.raw,
          maxBytes,
        },
        reply,
      );
    },
  });
}
