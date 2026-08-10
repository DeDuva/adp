import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { orgs, repos } from "../db/schema.js";
import type { OrgLandContext } from "./land-policy.js";

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
