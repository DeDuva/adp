import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { identities } from "../db/schema.js";

// M4-3: automated processes (today: the workspace sweeper) still need a real
// identity to attribute their operations to — `operations.actorId` is a hard
// FK, same reason every other write path has one. One row per principal,
// found-or-created so a restart doesn't fork a second "system" identity with
// its own disjoint operation history.
//
// `identities.principal` carries no unique constraint (a pre-existing choice
// — mirrors.ts mints a fresh identity per mirror without one), so two server
// processes racing to start at once could each insert a "system:..." row
// before either sees the other's. Accepted, not fixed here: the failure mode
// is two identities sharing attribution for sweeps rather than one, which is
// cosmetic, not a correctness or security issue, and this is a rare,
// effectively single-instance event today.
export async function findOrCreateSystemIdentity(db: Db, principal: string): Promise<string> {
  const [existing] = await db.select({ id: identities.id }).from(identities).where(eq(identities.principal, principal));
  if (existing) return existing.id;
  const [created] = await db.insert(identities).values({ kind: "agent", principal }).returning({ id: identities.id });
  return created!.id;
}
