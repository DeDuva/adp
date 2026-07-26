import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import type { Db } from "../db/client.js";
import { authenticate, type AuthenticatedIdentity } from "./tokens.js";

declare module "fastify" {
  interface FastifyRequest {
    identity?: AuthenticatedIdentity;
  }
}

function extractToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  if (auth?.startsWith("token ")) return auth.slice("token ".length);

  // git-over-HTTP basic auth: `username=x-access-token, password=<token>`
  if (auth?.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx !== -1) return decoded.slice(idx + 1);
  }
  return null;
}

export function authPlugin(db: Db) {
  return fp(async (app: FastifyInstance) => {
    app.decorateRequest("identity", undefined);

    app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
      const token = extractToken(req);
      if (!token) return;
      const identity = await authenticate(db, token);
      if (identity) req.identity = identity;
    });
  });
}

export function requireAuth(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  if (!req.identity) {
    reply.code(401).send({ message: "Requires authentication" });
    return;
  }
  done();
}

// Scopes are minted (auth/tokens.ts mintToken) but were never checked
// anywhere before this — any authenticated token could do anything.
// "admin" satisfies every check; "repo:write" also satisfies "repo:read"
// (a write token can obviously read), matching GitHub's own scope nesting.
export function hasScope(scopes: string[], required: "repo:read" | "repo:write"): boolean {
  if (scopes.includes("admin")) return true;
  if (scopes.includes(required)) return true;
  return required === "repo:read" && scopes.includes("repo:write");
}

export function requireScope(scope: "repo:read" | "repo:write") {
  return function (req: FastifyRequest, reply: FastifyReply, done: () => void) {
    if (!req.identity) {
      reply.code(401).header("WWW-Authenticate", "Basic realm=adp").send({ message: "Requires authentication" });
      return;
    }
    if (!hasScope(req.identity.scopes, scope)) {
      reply.code(403).send({ message: `Requires scope '${scope}'` });
      return;
    }
    done();
  };
}
