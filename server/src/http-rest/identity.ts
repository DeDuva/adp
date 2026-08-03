import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/plugin.js";

// gh auth status and every Octokit client probe these before doing anything else.
export function registerIdentityRoutes(app: FastifyInstance, publicUrl: string) {
  // Both spellings, because `gh auth status` probes the API root *with* a
  // trailing slash and Fastify treats "/api/v3" and "/api/v3/" as distinct
  // routes — the bare-path-only version 404s the probe, and gh then reports a
  // perfectly valid token as invalid. Real GitHub and GHES accept both.
  //
  // Registered here rather than via Fastify's global ignoreTrailingSlash: that
  // flag fixes this path but breaks @fastify/static's directory index, taking
  // /ui/ offline (see main.ts).
  for (const apiRoot of ["/api/v3", "/api/v3/"]) {
    app.get(apiRoot, { preHandler: requireAuth }, async (req, reply) => {
      reply.header("X-OAuth-Scopes", req.identity!.scopes.join(", "));
      // PUBLIC_URL, not req.protocol/req.hostname — behind deploy/'s Caddy the
      // inbound request is plain HTTP, so req.protocol advertises "http" for an
      // HTTPS deployment. Same reasoning as clone_url in http-rest/repos.ts.
      reply.send({ current_user_url: `${publicUrl.replace(/\/+$/, "")}/api/v3/user` });
    });
  }

  app.get("/api/v3/user", { preHandler: requireAuth }, async (req, reply) => {
    reply.header("X-OAuth-Scopes", req.identity!.scopes.join(", "));
    reply.send({ login: req.identity!.principal, id: req.identity!.identityId, type: "User" });
  });

  app.get("/api/v3/rate_limit", { preHandler: requireAuth }, async (_req, reply) => {
    reply.send({
      resources: {
        core: { limit: 5000, remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600 },
      },
      rate: { limit: 5000, remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600 },
    });
  });
}
