import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { GitBackend } from "./core/git-backend.js";
import { Signer } from "./core/signing.js";
import { authPlugin } from "./auth/plugin.js";
import { registerGitHttpRoutes } from "./http-git/proxy.js";
import { registerRepoRoutes } from "./http-rest/repos.js";
import { registerIdentityRoutes } from "./http-rest/identity.js";
import { registerIssueRoutes } from "./http-rest/issues.js";
import { registerChangeRoutes } from "./http-rest/changes.js";
import { registerProposalRoutes } from "./http-rest/proposals.js";
import { registerReviewRoutes } from "./http-rest/reviews.js";
import { registerGitDataRoutes } from "./http-rest/git-data.js";
import { loadGitHubSchema } from "./http-gql/schema.js";
import { attachResolvers } from "./http-gql/attach-resolvers.js";
import { createResolvers } from "./http-gql/resolvers.js";
import { registerGraphQLRoute } from "./http-gql/route.js";

async function main() {
  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL);
  const gitBackend = new GitBackend(config.GIT_ROOT);
  const signer = new Signer(config.SIGNING_KEY);

  const app = Fastify({ logger: true });

  // git smart-HTTP payloads (pack data) must reach the CGI subprocess untouched.
  app.addContentTypeParser(
    ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"],
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  await app.register(authPlugin(db));

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => {
    await pool.query("SELECT 1");
    return { status: "ok" };
  });

  registerIdentityRoutes(app);
  registerRepoRoutes(app, db, gitBackend);
  registerIssueRoutes(app, db);
  registerChangeRoutes(app, db, gitBackend, signer);
  registerProposalRoutes(app, db, gitBackend);
  registerReviewRoutes(app, db);
  registerGitDataRoutes(app, db, gitBackend);

  const gqlSchema = loadGitHubSchema();
  attachResolvers(gqlSchema, createResolvers(gitBackend));
  registerGraphQLRoute(app, gqlSchema, db);

  registerGitHttpRoutes(app, gitBackend);

  await app.listen({ host: "0.0.0.0", port: config.PORT });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
