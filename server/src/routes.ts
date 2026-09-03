import type { FastifyInstance } from "fastify";
import { API_VERSION, API_VERSION_HEADER } from "./api-version.js";
import type { Db } from "./db/client.js";
import type { GitBackend } from "./core/git-backend.js";
import { KeyRegistry, type Signer } from "./core/signing.js";
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
import { DEFAULT_RETENTION_DAYS } from "./core/trajectory-retention.js";
import { registerTokenRoutes } from "./http-rest/tokens.js";
import { registerOidcRoutes, type OidcConfig } from "./http-rest/oidc.js";
import { registerWorkspaceRoutes } from "./http-rest/workspaces.js";
import { registerEvidenceRoutes } from "./http-rest/evidence.js";
import { registerSessionRoutes } from "./http-rest/sessions.js";
import { registerRunRoutes } from "./http-rest/runs.js";
import { registerMirrorRoutes } from "./http-rest/mirrors.js";
import { registerActionsRoutes } from "./http-rest/actions.js";
import { registerNotImplementedHandler } from "./http-rest/not-implemented.js";
import { registerMirrorWebhookRoutes } from "./http-rest/mirror-webhook.js";
import { registerGitHubAppRoutes } from "./http-rest/github-app.js";
import { registerPortabilityRoutes } from "./http-rest/portability.js";
import { registerCandidateSetRoutes } from "./http-rest/candidate-sets.js";
import { registerWebhookRoutes } from "./http-rest/webhooks.js";
import { registerGitHttpRoutes } from "./http-git/proxy.js";
import { repoAccessCheck } from "./core/repos-lookup.js";
import { pushQuotaCheck } from "./core/storage-usage.js";
import { loadGitHubSchema } from "./http-gql/schema.js";
import { attachResolvers } from "./http-gql/attach-resolvers.js";
import { createResolvers } from "./http-gql/resolvers.js";
import { registerGraphQLRoute } from "./http-gql/route.js";

export interface RouteDeps {
  db: Db;
  gitBackend: GitBackend;
  signer: Signer;
  // #102: resolves envelope keyids, active + retired. Optional: harnesses
  // and tests that pass only a signer get single-key verification.
  keyRegistry?: KeyRegistry;
  publicUrl: string;
  credentialKey: string;
  instanceFloor: LandRequirement[];
  // #161: the trajectory retention window an org inherits when it sets none.
  // Optional so every test app that predates retention keeps constructing
  // routes unchanged, and defaulted to the same number `config.ts` serves.
  retentionDays?: number;
  gitMaxPackBytes?: number;
  // M4-5: present only when the instance has been given IdP credentials.
  // Absent is the normal case for a single-tenant instance and for every test
  // that predates OIDC, and it means the two /auth/oidc routes do not exist —
  // not that they exist and refuse.
  oidc?: OidcConfig;
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
  const retentionDays = deps.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const keyRegistry = deps.keyRegistry ?? new KeyRegistry(signer);

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

  // Before the routes, so it is in place whatever registration order does.
  // It serves no route — see not-implemented.ts on why that is the whole
  // point — so it cannot shadow one.
  registerNotImplementedHandler(app);

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
  registerOrgRoutes(app, db, gitBackend, instanceFloor, retentionDays);
  registerTokenRoutes(app, db);
  // Conditional, and the only conditional registration in this function. The
  // routes are absent rather than disabled when no IdP is configured, which
  // is what keeps spec-coverage honest: a route that exists must be in the
  // spec, and one that does not exist must not be reachable at all.
  if (deps.oidc) registerOidcRoutes(app, db, deps.oidc);
  registerWorkspaceRoutes(app, db, gitBackend);
  registerEvidenceRoutes(app, db);
  registerSessionRoutes(app, db, gitBackend, signer, publicUrl, keyRegistry);
  registerRunRoutes(app, db, gitBackend, signer, publicUrl, keyRegistry);
  registerMirrorRoutes(app, db, credentialKey);
  registerMirrorWebhookRoutes(app, db, gitBackend, signer, credentialKey, publicUrl, fetch, instanceFloor);
  registerGitHubAppRoutes(app, db, gitBackend, signer, credentialKey, publicUrl, fetch, instanceFloor);
  registerPortabilityRoutes(app, db, signer, publicUrl, keyRegistry);
  registerActionsRoutes(app, db, credentialKey);
  registerCandidateSetRoutes(app, db, gitBackend, instanceFloor, { signer, publicUrl });
  registerWebhookRoutes(app, db, credentialKey);

  const gqlSchema = loadGitHubSchema();
  attachResolvers(gqlSchema, createResolvers(gitBackend, credentialKey, instanceFloor, { signer, publicUrl }));
  registerGraphQLRoute(app, gqlSchema, db);

  registerGitHttpRoutes(app, repoAccessCheck(db), gitBackend, deps.gitMaxPackBytes, pushQuotaCheck(db));
}
