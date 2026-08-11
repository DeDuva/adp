import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { repos } from "../db/schema.js";

export async function findRepo(db: Db, owner: string, name: string) {
  const [repo] = await db
    .select()
    .from(repos)
    .where(and(eq(repos.owner, owner), eq(repos.name, name)));
  return repo ?? null;
}

// M4-9c: the gate-job checkout/complete routes are keyed by job id, not
// owner/repo — the job's own repoId is the only handle they have back to a
// real repository.
export async function findRepoById(db: Db, id: string) {
  const [repo] = await db.select().from(repos).where(eq(repos.id, id));
  return repo ?? null;
}
