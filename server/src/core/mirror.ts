import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "./git-backend.js";
import type { Signer } from "./signing.js";
import { mirrors, identities } from "../db/schema.js";
import { recordNewCommits } from "./change-recording.js";

const ZERO_SHA = "0".repeat(40);

export interface MirrorLogger {
  warn(msg: string): void;
  error(msg: string): void;
}

// GitHub's own header shape — an adopter pointing their existing GitHub
// webhook config at ADP (config.url = this endpoint) needs no changes on
// their end to get a verifiable signature.
export function verifyGithubSignature(secret: string, body: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const expectedBuf = Buffer.from(expected);
  const headerBuf = Buffer.from(header);
  if (expectedBuf.length !== headerBuf.length) return false;
  return timingSafeEqual(expectedBuf, headerBuf);
}

export async function findMirror(db: Db, repoId: string) {
  const [mirror] = await db.select().from(mirrors).where(eq(mirrors.repoId, repoId));
  return mirror ?? null;
}

// Outbound leg: after a local push lands, push the same ref to the
// configured remote. Fire-and-forget like core/webhooks.ts's emitter and for
// the same reason — the local push already succeeded, and a slow or
// unreachable mirror target must not hold up the pushing client.
export function pushToMirror(
  gitBackend: GitBackend,
  owner: string,
  name: string,
  mirror: { remoteUrl: string; direction: string; active: boolean },
  ref: string,
  logger: MirrorLogger,
): void {
  if (!mirror.active || mirror.direction === "pull") return;
  gitBackend.pushToRemote(owner, name, mirror.remoteUrl, ref).catch((err) => {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error(`mirror push to ${mirror.remoteUrl} (${ref}) failed: ${reason}`);
  });
}

export interface GithubPushPayload {
  ref: string;
  before: string;
  after: string;
}

export type IngestResult =
  | { ok: true; recordedRef: string; sha: string }
  | { ok: false; status: 400 | 404 | 422; message: string };

// Inbound leg: GitHub's webhook payload carries metadata (ref/before/after)
// but not the actual git objects, so this fetches them from the mirror's own
// remote before doing anything else — the payload is a notification to go
// get the truth, not the truth itself. Attributed to whoever configured the
// mirror (schema.ts's comment on `mirrors.configuredById`); GitHub's
// `pusher.login` isn't an ADP identity.
export async function ingestMirrorPush(
  db: Db,
  gitBackend: GitBackend,
  signer: Signer,
  repo: { id: string; owner: string; name: string },
  mirror: { remoteUrl: string; direction: string; active: boolean; configuredById: string },
  payload: GithubPushPayload,
): Promise<IngestResult> {
  if (!mirror.active || mirror.direction === "push") {
    return { ok: false, status: 422, message: "this mirror does not accept inbound pushes" };
  }

  const [identity] = await db.select().from(identities).where(eq(identities.id, mirror.configuredById));
  if (!identity) {
    return { ok: false, status: 422, message: "the identity that configured this mirror no longer exists" };
  }

  const fetchedSha = await gitBackend.fetchFromRemote(repo.owner, repo.name, mirror.remoteUrl, payload.ref);
  if (fetchedSha !== payload.after) {
    return {
      ok: false,
      status: 422,
      message: `fetched ${fetchedSha} does not match webhook payload's "after" (${payload.after})`,
    };
  }

  const priorSha = await gitBackend.resolveRef(repo.owner, repo.name, payload.ref.replace(/^refs\/heads\//, ""));
  const commits =
    priorSha && priorSha !== payload.before
      ? // The local ref has already moved past `before` some other way —
        // record only what's actually new to us rather than trusting the
        // webhook's own range, which was computed against GitHub's history.
        await gitBackend.log(repo.owner, repo.name, `${priorSha}..${fetchedSha}`, 500)
      : payload.before === ZERO_SHA
        ? // A first mirror import: unlike an ordinary local push's "new
          // branch, tip only" shortcut (http-git/hooks.ts), there is no
          // already-recorded history this could have forked from — walk the
          // whole reachable history instead (still capped, not chunked; see
          // the M2 scale-hygiene slice for the general fix).
          await gitBackend.log(repo.owner, repo.name, fetchedSha, 500)
        : await gitBackend.log(repo.owner, repo.name, `${payload.before}..${fetchedSha}`, 500);

  await gitBackend.createRef(repo.owner, repo.name, payload.ref, fetchedSha);
  await recordNewCommits(db, signer, repo, repo.owner, repo.name, identity, commits, "mirror-ingest");

  return { ok: true, recordedRef: payload.ref, sha: fetchedSha };
}
