import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend, CommitInfo } from "../core/git-backend.js";
import type { Signer } from "../core/signing.js";
import { changes, identities } from "../db/schema.js";
import { recordOperation } from "../core/operations.js";
import { findRepo } from "../core/repos-lookup.js";
import { BundledSecretScanProvider, type SecretScanProvider } from "../core/secret-scan.js";

const ZERO_SHA = "0".repeat(40);

// A ref update spanning more than this many new commits (a mirrored import of
// real GitHub history, not an incremental push) is recorded page by page
// instead of via one `git log --max-count=500` call — that single call used
// to silently drop everything past the newest 500 commits, which is the one
// failure mode this product cannot have: a gap in the provenance record.
const RECORD_BATCH_SIZE = 500;

async function recordCommitsBatch(
  db: Db,
  signer: Signer,
  repo: { id: string },
  owner: string,
  name: string,
  identity: { id: string; kind: string; principal: string },
  commits: CommitInfo[],
): Promise<void> {
  if (commits.length === 0) return;
  const shas = commits.map((c) => c.sha);
  const existingRows = await db
    .select({ gitSha: changes.gitSha })
    .from(changes)
    .where(and(eq(changes.repoId, repo.id), inArray(changes.gitSha, shas)));
  const existing = new Set(existingRows.map((r) => r.gitSha));
  const toRecord = commits.filter((c) => !existing.has(c.sha));
  if (toRecord.length === 0) return;

  // One transaction per batch (not per commit) — a >500-commit mirror import
  // used to do one DB round-trip per commit; this keeps the per-commit
  // signature and operations row (the append-only spine invariant) but pages
  // the round-trips instead.
  await db.transaction(async (tx) => {
    for (const commit of toRecord) {
      const provenance = { kind: identity.kind, principal: identity.principal, via: "push" };
      const signature = signer.sign({
        repo: `${owner}/${name}`,
        git_sha: commit.sha,
        intent_id: null,
        provenance,
      });

      const [change] = await tx
        .insert(changes)
        .values({ repoId: repo.id, gitSha: commit.sha, intentId: null, provenance, signature })
        .returning();

      await recordOperation(tx, {
        repoId: repo.id,
        actorId: identity.id,
        verb: "change.create",
        target: `${owner}/${name}@${commit.sha}`,
        after: { id: change!.id, gitSha: commit.sha, via: "push" },
      });
    }
  });
}

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

    for (const update of updates) {
      if (update.newSha === ZERO_SHA) continue;

      // operations.actorId is a hard FK to identities — without a resolved
      // identity there's no valid actor to attribute this to, so there's
      // nothing safe to record (this shouldn't happen in practice: pushing
      // at all requires an authenticated identity, so identityId should
      // always resolve).
      if (!identity) continue;

      // A brand-new branch (oldSha all-zero) usually forks from history
      // that's already recorded via whatever ref it was pushed from —
      // recording the tip only (not the whole reachable history) avoids
      // re-recording everything on every new branch. `existing change`
      // dedup in recordCommitsBatch covers the rest regardless.
      //
      // This shortcut is wrong for one case this file doesn't handle yet: a
      // *first* mirror import, where `main` is pushed as a brand-new branch
      // on the ADP side but carries real, never-before-seen history (there's
      // nothing else it could have forked from that's "already recorded").
      // Mirror mode (docs/pragmatic_mvp.md M2) needs its own bulk-import path
      // that walks full history rather than relying on this heuristic — this
      // is the reason it can't just reuse the push hook as-is.
      if (update.oldSha === ZERO_SHA) {
        const commits = await gitBackend.log(owner, name, update.newSha, 1);
        await recordCommitsBatch(db, signer, repo, owner, name, identity, commits);
        continue;
      }

      // Page through the whole range in RECORD_BATCH_SIZE-sized batches —
      // this is what turns a >500-commit mirror import into a complete
      // record instead of a truncated one.
      let skip = 0;
      for (;;) {
        const batch = await gitBackend.log(owner, name, `${update.oldSha}..${update.newSha}`, RECORD_BATCH_SIZE, skip);
        if (batch.length === 0) break;
        await recordCommitsBatch(db, signer, repo, owner, name, identity, batch);
        if (batch.length < RECORD_BATCH_SIZE) break;
        skip += RECORD_BATCH_SIZE;
      }
    }

    reply.send({ ok: true });
  });
}
