import type { FastifyInstance } from "fastify";
import { API_VERSION, API_VERSION_HEADER } from "./api-version.js";
import type { Db } from "./db/client.js";
import type { GitBackend } from "./core/git-backend.js";
import type { Signer } from "./core/signing.js";
import type { LandRequirement } from "./core/repo-policy.js";
import { registerRepoRoutes } from "./http-rest/repos.js";
import { registerIdentityRoutes } from "./http-rest/identity.js";
import { registerIssueRoutes } from "./http-rest/issues.js";
import { registerChangeRoutes } from "./http-rest/changes.js";
import { registerProposalRoutes } from "./http-rest/proposals.js";
import { registerReviewRoutes } from "./http-rest/reviews.js";
import { registerGitDataRoutes } from "./http-rest/git-data.js";
import { registerHookRoutes } from "./http-git/hooks.js";
import { registerGateRoutes } from "./http-rest/gates.js";
import { registerGateJobRoutes } from "./http-rest/gate-jobs.js";
import { registerDependencyAdmissionRoutes } from "./http-rest/dependency-admission.js";
import { registerOperationRoutes } from "./http-rest/operations.js";
import { registerAuditLogRoutes } from "./http-rest/audit-log.js";
import { registerOrgRoutes } from "./http-rest/orgs.js";
import { registerWorkspaceRoutes } from "./http-rest/workspaces.js";
import { registerEvidenceRoutes } from "./http-rest/evidence.js";
import { registerSessionRoutes } from "./http-rest/sessions.js";
import { registerRunRoutes } from "./http-rest/runs.js";
import { registerMirrorRoutes } from "./http-rest/mirrors.js";
import { registerActionsRoutes } from "./http-rest/actions.js";
import { registerMirrorWebhookRoutes } from "./http-rest/mirror-webhook.js";
import { registerCandidateSetRoutes } from "./http-rest/candidate-sets.js";
import { registerWebhookRoutes } from "./http-rest/webhooks.js";
import { registerGitHttpRoutes } from "./http-git/proxy.js";
import { loadGitHubSchema } from "./http-gql/schema.js";
import { attachResolvers } from "./http-gql/attach-resolvers.js";
import { createResolvers } from "./http-gql/resolvers.js";
import { registerGraphQLRoute } from "./http-gql/route.js";

export interface RouteDeps {
  db: Db;
  gitBackend: GitBackend;
  signer: Signer;
  publicUrl: string;
  credentialKey: string;
  instanceFloor: LandRequirement[];
  gitMaxPackBytes?: number;
}

// Every HTTP surface this server exposes, in one place.
//
// Extracted from main.ts so that something other than a running server can
// enumerate the routes — specifically `spec-coverage.test.ts`, which asserts
// that `spec/openapi.yaml` and the implementation describe the same API. That
// check is only worth anything if it reads the *real* registration list rather
// than a copy of it that can drift, which is exactly the failure it exists to
// catch.
//
// main.ts keeps what is genuinely process-level and deliberately outside the
// documented API: liveness probes, the Prometheus endpoint, the static UI, and
// the mirror poller.
export function registerApiRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, gitBackend, signer, publicUrl, credentialKey, instanceFloor } = deps;

  // Served on every response, including 401s and 404s. A client pins the
  // contract before it can authenticate, so gating this behind a successful
  // request would leave the one case that matters — pointing a generated client
  // at the wrong instance — undetectable until a real call failed.
  //
  // onRequest rather than onSend: the header is metadata about the server, not
  // about the payload, and this way it never participates in payload
  // transformation. The git smart-HTTP routes hijack the reply
  // (http-git/proxy.ts) and so are not covered — the wire protocol there is
  // git's, proxied verbatim, and is not part of this contract.
  app.addHook("onRequest", async (_req, reply) => {
    reply.header(API_VERSION_HEADER, API_VERSION);
  });

  registerIdentityRoutes(app, publicUrl);
  registerRepoRoutes(app, db, gitBackend, publicUrl);
  registerIssueRoutes(app, db);
  registerChangeRoutes(app, db, gitBackend, signer);
  registerProposalRoutes(app, db, gitBackend, credentialKey, instanceFloor, { signer, publicUrl });
  registerReviewRoutes(app, db);
  registerGitDataRoutes(app, db, gitBackend);
  registerHookRoutes(app, db, gitBackend, signer, credentialKey);
  registerGateRoutes(app, db, signer, publicUrl, credentialKey);
  registerGateJobRoutes(app, db, gitBackend, signer, publicUrl, credentialKey);
  registerDependencyAdmissionRoutes(app, db, signer, publicUrl);
  registerOperationRoutes(app, db, gitBackend);
  registerAuditLogRoutes(app, db);
  registerOrgRoutes(app, db, gitBackend, instanceFloor);
  registerWorkspaceRoutes(app, db, gitBackend);
  registerEvidenceRoutes(app, db);
  registerSessionRoutes(app, db, gitBackend, signer, publicUrl);
  registerRunRoutes(app, db, gitBackend, signer, publicUrl);
  registerMirrorRoutes(app, db, credentialKey);
  registerMirrorWebhookRoutes(app, db, gitBackend, signer, credentialKey, publicUrl);
  registerActionsRoutes(app, db, credentialKey);
  registerCandidateSetRoutes(app, db, gitBackend, instanceFloor, { signer, publicUrl });
  registerWebhookRoutes(app, db, credentialKey);

  const gqlSchema = loadGitHubSchema();
  attachResolvers(gqlSchema, createResolvers(gitBackend, credentialKey, instanceFloor, { signer, publicUrl }));
  registerGraphQLRoute(app, gqlSchema, db);

  registerGitHttpRoutes(app, gitBackend, deps.gitMaxPackBytes);
}
