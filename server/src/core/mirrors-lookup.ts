import { and, asc, eq, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { mirrors, repos } from "../db/schema.js";

export async function findMirror(db: Db, repoId: string) {
  const [mirror] = await db.select().from(mirrors).where(eq(mirrors.repoId, repoId));
  return mirror ?? null;
}

/**
 * Whether this repository takes its issues and pull requests from upstream.
 *
 * The signal is the mirror, not a separate switch: an enabled mirror that can
 * receive *is* a repository whose issues and pull requests are GitHub's,
 * because that is what inbound means. A second flag would be a second thing to
 * get wrong, and the failure it would allow — ingest on, native creation also
 * on — is exactly the number collision the 5a numbering decision exists to
 * prevent.
 *
 * It lives here rather than beside either ingest because it gates both, and a
 * predicate owned by one of two callers is one the other imports for reasons
 * that stop being obvious.
 */
export async function upstreamIngestEnabled(db: Db, repoId: string): Promise<boolean> {
  const mirror = await findMirror(db, repoId);
  return !!mirror?.enabled && (mirror.direction === "inbound" || mirror.direction === "both");
}

/**
 * Every mirror pointing at a given upstream repository, with the ADP repo each
 * belongs to.
 *
 * Plural because nothing stops two ADP repositories mirroring one upstream, and
 * a lookup that returned the first would make which of them got the record an
 * arbitrary function of insertion order. Delivering to all of them is the only
 * answer that does not silently pick a winner.
 *
 * A GitHub App delivers every installation's events to one endpoint, so unlike
 * the per-repository webhook — whose URL names the ADP repo — the App path has
 * only `repository.full_name` and has to find its way back from that.
 *
 * Matched on the remote URL with and without the `.git` suffix rather than by
 * parsing it, because both spellings are what people actually configure and a
 * parser here would be a second, quietly different implementation of
 * `parseGitHubRemote`.
 */
export async function findMirrorsByUpstream(db: Db, host: string, fullName: string) {
  const base = `https://${host}/${fullName}`;
  return db
    .select({ mirror: mirrors, repo: repos })
    .from(mirrors)
    .innerJoin(repos, eq(mirrors.repoId, repos.id))
    .where(and(eq(mirrors.enabled, true), or(eq(mirrors.remoteUrl, base), eq(mirrors.remoteUrl, `${base}.git`))))
    .orderBy(asc(repos.owner), asc(repos.name));
}
