import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/plugin.js";

// gh auth status and every Octokit client probe these before doing anything else.
export function registerIdentityRoutes(app: FastifyInstance) {
  app.get("/api/v3", { preHandler: requireAuth }, async (req, reply) => {
    reply.header("X-OAuth-Scopes", req.identity!.scopes.join(", "));
    reply.send({ current_user_url: `${req.protocol}://${req.hostname}/api/v3/user` });
  });

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
