import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client.js";
import { orgs, orgMemberships } from "../src/db/schema.js";

// #91: a repo can only be created inside an org that already exists, by a
// member of it — the data plane then refuses every non-member. Before #91 a
// test could invent an owner string and go; now each test arranges the same
// state a real deployment would have (an org, provisioned; a membership,
// granted) with this one call. Idempotent, so a file may call it for as
// many identity/owner pairs as it needs.
export async function grantOwner(db: Db, identityId: string, owner: string): Promise<string> {
  const [inserted] = await db.insert(orgs).values({ name: owner }).onConflictDoNothing().returning({ id: orgs.id });
  const orgId = inserted?.id ?? (await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.name, owner)))[0]!.id;
  await db.insert(orgMemberships).values({ orgId, identityId }).onConflictDoNothing();
  return orgId;
}
