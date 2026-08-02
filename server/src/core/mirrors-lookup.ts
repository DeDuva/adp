import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { mirrors } from "../db/schema.js";

export async function findMirror(db: Db, repoId: string) {
  const [mirror] = await db.select().from(mirrors).where(eq(mirrors.repoId, repoId));
  return mirror ?? null;
}
