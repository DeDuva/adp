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
