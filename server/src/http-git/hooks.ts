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

const ZERO_SHA = "0".repeat(40);

// These routes are only ever called by the pre-receive/post-receive hook
// scripts this same server writes into each bare repo at creation
// (core/git-backend.ts's initBareRepo) — never by an external client. No
// bearer-token auth applies here (the hook has no user-facing token to
// present); trust is instead scoped to "requests from this host", which is
// what actually matters for a hook subprocess spawned locally by `git
// receive-pack`. Good enough for the MVP's single-host deployment
// (docs/pragmatic_mvp.md §4.1); revisit if/when the git and API planes ever
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
  updates: z.array(z.object({ oldSha: z.string(), newSha: z.string(), ref: z.string() })),
});

export function registerHookRoutes(
  app: FastifyInstance,
  db: Db,
  gitBackend: GitBackend,
  signer: Signer,
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
    const { owner, name, identityId, updates } = parsed.data;
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
          { id: identity.id, kind: identity.kind, principal: identity.principal },
          update.oldSha,
          update.newSha,
          "push",
        );
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
