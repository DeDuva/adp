import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { requireScope } from "../auth/plugin.js";
import { findRepoAuthorized } from "../core/repos-lookup.js";
import type { Signer, KeyRegistry } from "../core/signing.js";
import { exportRepository, importRepository, type ExportBundle } from "../core/portability.js";

// Moving a repository's record between instances.
//
// Two routes, and the asymmetry between their scopes is deliberate. Export is
// `repo:read` — it returns what a reader of this repository can already see,
// assembled — while import is `admin`, because it writes signed records this
// instance did not produce and adds a verification key to it. The second is a
// trust decision about another instance, which is not a thing repo:write should
// be able to make.
export function registerPortabilityRoutes(
  app: FastifyInstance,
  db: Db,
  signer: Signer,
  publicUrl: string,
  keyRegistry?: KeyRegistry,
) {
  app.get(
    "/api/adp/repos/:owner/:repo/export",
    { preHandler: requireScope("repo:read") },
    async (req, reply) => {
      const { owner, repo: repoName } = req.params as { owner: string; repo: string };
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const bundle = await exportRepository(
        db,
        { id: repo.id, owner, name: repoName, defaultBranch: repo.defaultBranch },
        { publicUrl, signingPublicKey: signer.publicKeyHex },
      );
      reply.send(bundle);
    },
  );

  app.post(
    "/api/adp/repos/:owner/:repo/import",
    { preHandler: requireScope("admin") },
    async (req, reply) => {
      const { owner, repo: repoName } = req.params as { owner: string; repo: string };
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        // The repository has to exist here first, and deliberately: creating it
        // as a side effect of an import would mean an import could place a
        // repository under an org the caller was never admitted to, which is
        // the check #91 exists to make.
        reply.code(404).send({
          message: `Repository ${owner}/${repoName} not found`,
          adp_equivalent:
            "Create it first — POST /api/v3/repos/{owner} — then import into it. The git history " +
            "moves with `git push`; this bundle carries what git cannot.",
        });
        return;
      }

      const result = await importRepository(
        db,
        req.body as ExportBundle,
        { id: repo.id, owner, name: repoName },
        req.identity!.identityId,
        keyRegistry,
      );
      if (!result.ok) {
        reply.code(result.status).send({ message: result.message });
        return;
      }
      reply.send({
        repo_id: result.repoId,
        imported: result.counts,
        key_archived: result.keyArchived,
        // Said out loud, because it is the one thing an operator will assume
        // happened and it did not. The bundle is the record; the commits are
        // still wherever they were.
        note: "signatures are unchanged and the exporting instance's key is archived here. Git history moves separately, with `git push`.",
      });
    },
  );
}
