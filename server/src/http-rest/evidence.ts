import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { requireScope } from "../auth/plugin.js";
import { findRepo } from "../core/repos-lookup.js";
import { getEvidenceBundle } from "../core/evidence.js";

// Native plane (docs/pragmatic_mvp.md Tier 4) — "adp_evidence_get: full
// signed bundle for a change". Assembles, doesn't store — see core/evidence.ts.
export function registerEvidenceRoutes(app: FastifyInstance, db: Db) {
  app.get(
    "/api/adp/repos/:owner/:repo/evidence/:sha",
    { preHandler: requireScope("repo:read") },
    async (req, reply) => {
      const { owner, repo: repoName, sha } = req.params as { owner: string; repo: string; sha: string };
      const repo = await findRepo(db, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }
      const bundle = await getEvidenceBundle(db, repo.id, sha);
      reply.send(bundle);
    },
  );
}
