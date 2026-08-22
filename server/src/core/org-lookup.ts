import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { orgs, repos } from "../db/schema.js";
import type { OrgLandContext } from "./land-policy.js";

// Shared by bootstrap.ts (--org) and http-rest/repos.ts (M4-3: every repo
// gets an org going forward, the same way the M4-0 migration backfilled
// every repo that predates it). `Pick` rather than `Db` so a transaction
// (`tx` inside `db.transaction()`) satisfies it too, same reasoning
// core/operations.ts's recordOperation uses.
export async function findOrCreateOrg(db: Pick<Db, "select" | "insert">, name: string) {
  const [existing] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.name, name));
  if (existing) return existing.id;
  // Two concurrent creates under one fresh owner both reach this insert;
  // orgs.name is unique, so without the conflict clause the loser is an
  // unhandled 23505. DO NOTHING returns no row to the loser — re-select and
  // use the winner's org, which is the same org this caller wanted.
  const [created] = await db.insert(orgs).values({ name }).onConflictDoNothing().returning({ id: orgs.id });
  if (created) return created.id;
  const [raced] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.name, name));
  return raced!.id;
}

// `orgId` is a repo's own `repos.orgId` — null for every pre-M4 repo, which
// is exactly when this returns null and land-policy.ts treats the repo as
// having no org contribution at all (the M4-0 backward-compatibility case).
export async function findOrgLandContext(db: Db, orgId: string | null): Promise<OrgLandContext | null> {
  if (!orgId) return null;

  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return null;

  if (!org.policyRepoId) {
    return { killSwitch: org.killSwitch, policyRepo: null };
  }

  const [policyRepo] = await db.select().from(repos).where(eq(repos.id, org.policyRepoId));
  return {
    killSwitch: org.killSwitch,
    policyRepo: policyRepo ? { owner: policyRepo.owner, name: policyRepo.name, defaultBranch: policyRepo.defaultBranch } : null,
  };
}
