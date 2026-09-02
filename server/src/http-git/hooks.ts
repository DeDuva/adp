import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "../core/git-backend.js";
import type { Signer } from "../core/signing.js";
import { identities, mirrorSyncLog } from "../db/schema.js";
import { findRepo } from "../core/repos-lookup.js";
import { findMirror } from "../core/mirrors-lookup.js";
import { recordPushedCommits } from "../core/change-recorder.js";
import { BundledSecretScanProvider, type SecretScanProvider } from "../core/secret-scan.js";
import { emitWebhookEvent } from "../core/webhooks.js";
import { loadRepoPolicy } from "../core/repo-policy.js";
import { enqueueGateJob } from "../core/gate-jobs.js";

const ZERO_SHA = "0".repeat(40);

// These routes are only ever called by the pre-receive/post-receive hook
// scripts this same server writes into each bare repo at creation
// (core/git-backend.ts's initBareRepo) — never by an external client. No
// bearer-token auth applies here (the hook has no user-facing token to
// present); trust is instead scoped to "requests from this host", which is
// what actually matters for a hook subprocess spawned locally by `git
// receive-pack`. Good enough for the MVP's single-host deployment
//; revisit if/when the git and API planes ever
// run on separate hosts.
function requireLoopback(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  const ip = req.ip;
  if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
    reply.code(403).send({ message: "internal endpoint" });
    return;
  }
  done();
}

const PreReceiveBody = z.object({
  owner: z.string(),
  name: z.string(),
  identityId: z.string().uuid().nullable(),
  // The hook script computes each update's diff itself and ships the text —
  // see git-backend.ts's hookScript comment for why (object quarantine).
  updates: z.array(z.object({ oldSha: z.string(), newSha: z.string(), ref: z.string(), patch: z.string() })),
});

const PostReceiveBody = z.object({
  owner: z.string(),
  name: z.string(),
  identityId: z.string().uuid().nullable(),
  // #229: nullish rather than required, so a hook script written into a bare
  // repo before this existed keeps working. The scripts are rewritten only at
  // repo creation (initBareRepo), so every repository that already exists is
  // still running the old one until it is recreated — a required field here
  // would turn that into a rejected recording on every push.
  harness: z.string().nullish(),
  model: z.string().nullish(),
  sessionId: z.string().nullish(),
  updates: z.array(z.object({ oldSha: z.string(), newSha: z.string(), ref: z.string() })),
});

export function registerHookRoutes(
  app: FastifyInstance,
  db: Db,
  gitBackend: GitBackend,
  signer: Signer,
  credentialKey: string,
  scanner: SecretScanProvider = new BundledSecretScanProvider(),
) {
  // Pre-receive: runs before refs move. A nonzero-equivalent {block: true}
  // response becomes the hook script's nonzero exit, which git surfaces to
  // the pushing client as a rejected push with our message — non-bypassable
  // below this floor because there's no per-repo config surface yet to turn
  // it off (the instance-wide default *is* the floor for now).
  app.post("/internal/hooks/pre-receive", { preHandler: requireLoopback }, async (req, reply) => {
    const parsed = PreReceiveBody.safeParse(req.body);
    if (!parsed.success) {
      reply.send({ block: true, message: "malformed hook payload" });
      return;
    }
    const { owner, name, updates } = parsed.data;
    const repo = await findRepo(db, owner, name);
    if (!repo) {
      // Shouldn't happen (the hook only exists inside a repo we created),
      // but failing open here would defeat the point of a policy floor.
      reply.send({ block: true, message: `repository ${owner}/${name} not found` });
      return;
    }

    const findings: { ref: string; pattern: string; line: number; excerpt: string }[] = [];
    for (const update of updates) {
      if (update.newSha === ZERO_SHA) continue; // branch/tag deletion — nothing new to scan
      for (const finding of scanner.scanDiff(update.patch)) {
        findings.push({ ...finding, ref: update.ref });
      }
    }

    if (findings.length > 0) {
      reply.send({
        block: true,
        message: `push blocked: ${findings.length} potential secret(s) detected`,
        findings,
      });
      return;
    }

    reply.send({ block: false });
  });

  // Post-receive: refs have already moved. Auto-records a typed `changes`
  // row per new commit — the thing changes.ts used to require an explicit
  // POST for (see its comment). Never blocks: the push already succeeded:
  // any error will get logged but a failure here is a bookkeeping problem
  // to reconcile, not a reason to have refused the push after the fact.
  app.post("/internal/hooks/post-receive", { preHandler: requireLoopback }, async (req, reply) => {
    const parsed = PostReceiveBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ message: "malformed hook payload" });
      return;
    }
    const { owner, name, identityId, harness, model, sessionId, updates } = parsed.data;
    const repo = await findRepo(db, owner, name);
    if (!repo) {
      reply.send({ ok: true });
      return;
    }

    const identity = identityId ? (await db.select().from(identities).where(eq(identities.id, identityId)))[0] : undefined;
    const mirror = await findMirror(db, repo.id);
    const mirrorOutbound = mirror?.enabled && (mirror.direction === "outbound" || mirror.direction === "both") ? mirror : null;

    for (const update of updates) {
      if (update.newSha === ZERO_SHA) continue;

      // operations.actorId is a hard FK to identities — without a resolved
      // identity there's no valid actor to attribute this to, so there's
      // nothing safe to record (this shouldn't happen in practice: pushing
      // at all requires an authenticated identity, so identityId should
      // always resolve).
      if (identity) {
        // Chunking past a single 500-commit `git log` call (a >500-commit
        // mirror import, not an ordinary push) lives inside
        // recordPushedCommits itself (core/change-recorder.ts) — shared with
        // the inbound mirror webhook, so both callers get the fix.
        await recordPushedCommits(
          db,
          gitBackend,
          signer,
          owner,
          name,
          repo.id,
          {
            id: identity.id,
            kind: identity.kind,
            principal: identity.principal,
            // #229: how a change arrived must not determine the quality of its
            // provenance. This is the ambient path — the one 1b exists to make
            // the default — and until now it was the only one that dropped
            // these, silently, in a way no check could tell from a human
            // pushing without a harness.
            harness: harness ?? null,
            model: model ?? null,
            sessionId: sessionId ?? null,
          },
          update.oldSha,
          update.newSha,
          "push",
        );

        // Fire-and-forget (core/webhooks.ts) — the push already succeeded
        // and must not wait on a subscriber's endpoint. A fresh, capped log
        // call for the payload, decoupled from recordPushedCommits' own
        // (possibly paginated) recording pass — commits capped at 20,
        // matching GitHub's own push-event payload shape.
        const commitsForPayload =
          update.oldSha === ZERO_SHA
            ? await gitBackend.log(owner, name, update.newSha, 20)
            : await gitBackend.log(owner, name, `${update.oldSha}..${update.newSha}`, 20);
        emitWebhookEvent(
          db,
          repo.id,
          "push",
          {
            ref: update.ref,
            before: update.oldSha,
            after: update.newSha,
            repository: { full_name: `${owner}/${name}` },
            pusher: { name: identity.principal },
            commits: commitsForPayload.map((c) => ({
              id: c.sha,
              message: c.message,
              author: { name: c.authorName, email: c.authorEmail },
            })),
          },
          req.log,
          credentialKey,
        );

        // M4-9c: adp.yaml's `runner.gates` read off the *pushed* sha, not the
        // base ref — unlike the land-policy read in core/repo-policy.ts,
        // this is naming what command runs inside M4-9b's isolated,
        // network-denied, resource-capped container, which is exactly the
        // class of untrusted repo-specified code that container exists to
        // run safely. A branch's own adp.yaml choosing its own build/test
        // command is the ordinary case, not a policy bypass.
        const policy = await loadRepoPolicy(gitBackend, owner, name, update.newSha);
        if (policy.runner) {
          for (const gate of policy.runner.gates) {
            await enqueueGateJob(db, {
              repoId: repo.id,
              owner,
              repoName: name,
              gitSha: update.newSha,
              name: gate.name,
              image: policy.runner.image,
              command: policy.runner.setup ? `${policy.runner.setup} && ${gate.run}` : gate.run,
              timeoutMs: gate.timeout_ms,
              actorId: identity.id,
            });
          }
        }
      }

      // Queue the outbound push-out as an outbox row rather than pushing to
      // GitHub inline here — see core/mirror-poller.ts's comment for why
      // (keeps this hook's latency independent of GitHub's availability).
      if (mirrorOutbound) {
        await db.insert(mirrorSyncLog).values({
          mirrorId: mirrorOutbound.id,
          direction: "outbound",
          ref: update.ref,
          sha: update.newSha,
          status: "pending",
        });
      }
    }

    reply.send({ ok: true });
  });
}
