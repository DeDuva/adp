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
