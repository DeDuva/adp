import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import type { Db } from "../db/client.js";
import { authenticate, isOrgMember, type AuthenticatedIdentity } from "./tokens.js";

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
// "admin" satisfies the CRUD scopes; "repo:write" also satisfies
// "repo:read" (a write token can obviously read), matching GitHub's own
// scope nesting.
//
// "runner" is deliberately OUTSIDE admin's umbrella (#90, audit §P0-4):
// it is not a privilege level, it is a *plane* — the token type handed to
// the host that executes untrusted code. When admin satisfied runner, the
// path of least resistance for a deployment was to hand the runner its
// bootstrap admin token and watch it work; refusing admin here makes that
// lazy path fail closed, so the only token that can work the gate queue
// is one minted to hold nothing else (http-rest/tokens.ts).
export function hasScope(scopes: string[], required: "repo:read" | "repo:write" | "admin" | "runner"): boolean {
  if (required === "runner") return scopes.includes("runner");
  if (scopes.includes("admin")) return true;
  if (required === "admin") return false; // only an actual "admin" scope satisfies "admin" (checked above)
  if (scopes.includes(required)) return true;
  return required === "repo:read" && scopes.includes("repo:write");
}

export type RequiredScope = "repo:read" | "repo:write" | "admin" | "runner";

export function requireScope(scope: RequiredScope) {
  const handler = function (req: FastifyRequest, reply: FastifyReply, done: () => void) {
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
  // #97: the scope a route demands is part of the CONTRACT, so it must be
  // introspectable — spec-coverage.test.ts walks the real route table and
  // asserts each operation's `x-required-scope` in spec/openapi.yaml
  // matches the scope its preHandler actually enforces. A closure the test
  // can't see into is how the spec and prose drifted to begin with.
  handler.requiredScope = scope;
  return handler;
}

// M4-1: org-scoped routes call this *alongside* requireScope, not instead of
// it — the repo:read/repo:write/admin scopes stay the authority for what a
// token can DO; this is the separate question of which org's data it can do
// it to. `orgIdParam` names the route param carrying the target org id (the
// route decides its own shape, e.g. `/api/v3/orgs/:orgId/...`).
//
// Two checks, both required: the token's own orgId must match the route's
// target (a token scoped to org A is never valid against org B, even if the
// same human also belongs to B — the token is what carries the grant), and
// the identity must still be a member (catches a membership revoked after
// the token was minted).
export function requireOrgAccess(db: Db, orgIdParam: string) {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    if (!req.identity) {
      reply.code(401).send({ message: "Requires authentication" });
      return;
    }
    const targetOrgId = (req.params as Record<string, string | undefined>)[orgIdParam];
    if (!targetOrgId) {
      reply.code(400).send({ message: `Missing route param '${orgIdParam}'` });
      return;
    }
    if (req.identity.orgId !== targetOrgId) {
      reply.code(403).send({ message: "Token is not scoped to this org" });
      return;
    }
    if (!(await isOrgMember(db, targetOrgId, req.identity.identityId))) {
      reply.code(403).send({ message: "Not a member of this org" });
      return;
    }
  };
}
