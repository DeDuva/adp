import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { repos } from "../db/schema.js";
import { isOrgMember, type AuthenticatedIdentity } from "../auth/tokens.js";

// The raw lookup — no authorization. Route handlers must NOT call this with
// a caller-supplied owner/name; that's findRepoAuthorized's job (#91). The
// legitimate callers are the paths where authorization is someone else's
// problem or nobody's: the loopback-only git hook callbacks
// (http-git/hooks.ts), HMAC-authenticated mirror webhooks, and the repo
// create path's "does it exist yet" fast path.
export async function findRepo(db: Db, owner: string, name: string) {
  const [repo] = await db
    .select()
    .from(repos)
    .where(and(eq(repos.owner, owner), eq(repos.name, name)));
  return repo ?? null;
}

// #91 (audit §P0-1): may this identity touch this org's data at all?
// Layered like the org-metadata routes' requireOrgAccess, with one
// extension for the operator case:
//  - an instance operator (admin scope on a token bound to no org) passes —
//    that is the bootstrap token, and an operator who can mint any org's
//    tokens gains nothing from being fenced out of the data plane;
//  - an org-scoped token is valid only for its own org, even if the same
//    human belongs to others — the token is what carries the grant;
//  - and in every case the identity must still be a live member of the
//    repo's org, so a membership revoked after minting takes effect
//    immediately.
export async function mayAccessOrg(db: Db, identity: AuthenticatedIdentity, orgId: string): Promise<boolean> {
  if (identity.scopes.includes("admin") && identity.orgId === null) return true;
  if (identity.orgId !== null && identity.orgId !== orgId) return false;
  return await isOrgMember(db, orgId, identity.identityId);
}

// The route-facing lookup: resolves owner/name AND answers whether this
// identity may see it, in one call, returning null for "absent" and
// "forbidden" alike. Deliberately one answer for both — GitHub's own
// semantics for a repo you cannot see is 404, and a 403 would hand any
// authenticated token an oracle for which org names and repos exist.
export async function findRepoAuthorized(db: Db, identity: AuthenticatedIdentity, owner: string, name: string) {
  const repo = await findRepo(db, owner, name);
  if (!repo) return null;
  return (await mayAccessOrg(db, identity, repo.orgId)) ? repo : null;
}

// The same answer as a yes/no, for the git smart-HTTP proxy — which takes
// this as a callback rather than a Db so its wire-fidelity unit suite
// (http-git/proxy.test.ts) can keep running without Postgres, with the
// check stubbed open. Every DB-backed test and the isolation matrix
// exercise this real implementation.
export function repoAccessCheck(db: Db) {
  return async (identity: AuthenticatedIdentity, owner: string, name: string): Promise<boolean> =>
    (await findRepoAuthorized(db, identity, owner, name)) !== null;
}

// M4-9c: the gate-job checkout/complete routes are keyed by job id, not
// owner/repo — the job's own repoId is the only handle they have back to a
// real repository.
export async function findRepoById(db: Db, id: string) {
  const [repo] = await db.select().from(repos).where(eq(repos.id, id));
  return repo ?? null;
}
