import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { mirrors } from "../db/schema.js";

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
