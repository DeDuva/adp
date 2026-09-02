import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { externalIdentities, identities } from "../db/schema.js";

// Resolving a GitHub user to an ADP identity.
//
// Mirror inbound attributed everything it recorded to the mirror's own system
// identity, `mirror:github:<owner>/<name>` — every commit, and (since #224 and
// #226) every proposal and issue. That is a statement about how the record
// arrived, written into the field that is supposed to say who made the change.
// It also breaks the one thing 5-4 needs: `one_approval` is author-independent
// by construction (#121), and an approval attributed to the same system
// identity as the proposal it approves is the author's own.
//
// No new table. `external_identities` is already `(issuer, subject)`-keyed and
// provider-generic, which is exactly the shape needed — it exists because a
// deployment with two OIDC providers must not collide two people onto one
// identity, and a mirror host is another such provider.
//
// **The subject is the numeric user id wherever GitHub sends one**, because a
// login is renameable and an id is not. The problem is that GitHub does not
// send one everywhere: a `push` payload names a commit's author by `username`
// and nothing else, while `pull_request`, `issues` and `pull_request_review`
// all carry `user.id`. Keying on whichever is present would give one person two
// identities the first time they both push and open a pull request.
//
// So a login-only sighting is keyed `login:<login>` and **upgraded in place**
// the first time the same person is seen with an id. One row per person per
// host either way, and the id wins as soon as it is known.

export interface GitHubUserRef {
  id?: number | null;
  login?: string | null;
  /** GitHub's own account type. "Bot" becomes an agent identity, not a human. */
  type?: string | null;
}

export interface ResolvedGitHubIdentity {
  identityId: string;
  principal: string;
  kind: "human" | "agent";
}

/** The issuer half of the key: a URL, matching what the OIDC linker stores. */
export function githubIssuer(host: string): string {
  return `https://${host}`;
}

function principalFor(login: string): string {
  return `github:${login}`;
}

/**
 * Find or create the ADP identity for a GitHub user.
 *
 * Returns null when the payload names nobody — GitHub omits the user on a few
 * deliveries, and on a deleted account — so that the caller falls back to the
 * mirror's system identity rather than inventing a person. Attributing a change
 * to nobody in particular is worse than attributing it to the mirror, which at
 * least says truthfully how it arrived.
 */
export async function resolveGitHubIdentity(
  db: Db,
  host: string,
  user: GitHubUserRef | null | undefined,
): Promise<ResolvedGitHubIdentity | null> {
  const login = user?.login?.trim();
  const id = user?.id ?? null;
  if (!login && id === null) return null;

  const issuer = githubIssuer(host);
  const kind: "human" | "agent" = user?.type === "Bot" ? "agent" : "human";
  const principal = login ? principalFor(login) : `github:id:${id}`;
  const subject = id !== null ? String(id) : `login:${login}`;

  const byKey = await linkFor(db, issuer, subject);
  if (byKey) return byKey;

  if (id !== null && login) {
    // The upgrade. This person was seen by login first — from a `push`, which
    // is the only payload that names an author without an id — and is now seen
    // with one. Rewriting the subject keeps a single identity rather than
    // splitting their history in two at the moment they open a pull request.
    const legacy = await linkRowFor(db, issuer, `login:${login}`);
    if (legacy) {
      await db
        .update(externalIdentities)
        .set({ subject })
        .where(eq(externalIdentities.id, legacy.id));
      return { identityId: legacy.identityId, principal: legacy.principal, kind: legacy.kind };
    }
  }

  if (id === null && login) {
    // The mirror image: seen by login now, but already known by id from an
    // earlier pull request. The link cannot be found by subject, so it is found
    // by the principal that id-keyed row created.
    const [existing] = await db
      .select({ identityId: identities.id, principal: identities.principal, kind: identities.kind })
      .from(externalIdentities)
      .innerJoin(identities, eq(externalIdentities.identityId, identities.id))
      .where(and(eq(externalIdentities.issuer, issuer), eq(identities.principal, principal)))
      .limit(1);
    if (existing) {
      return {
        identityId: existing.identityId,
        principal: existing.principal,
        kind: existing.kind as "human" | "agent",
      };
    }
  }

  const created = await db.transaction(async (tx) => {
    const [identity] = await tx.insert(identities).values({ kind, principal }).returning();
    const [link] = await tx
      .insert(externalIdentities)
      .values({ issuer, subject, identityId: identity!.id })
      // Against the unique on (issuer, subject): two deliveries naming the same
      // person can race, and the loser must not leave a second identity linked
      // to nothing. It still leaves an orphan `identities` row, which is
      // harmless — nothing references it and nothing can authenticate as it —
      // where a failed insert would fail the whole delivery.
      .onConflictDoNothing()
      .returning();
    return link ? { identityId: identity!.id, principal, kind } : null;
  });
  if (created) return created;

  // Lost the race; the winner's row is the answer.
  return (await linkFor(db, issuer, subject)) ?? null;
}

async function linkFor(db: Db, issuer: string, subject: string): Promise<ResolvedGitHubIdentity | null> {
  const row = await linkRowFor(db, issuer, subject);
  return row ? { identityId: row.identityId, principal: row.principal, kind: row.kind } : null;
}

async function linkRowFor(db: Db, issuer: string, subject: string) {
  const [row] = await db
    .select({
      id: externalIdentities.id,
      identityId: externalIdentities.identityId,
      principal: identities.principal,
      kind: identities.kind,
    })
    .from(externalIdentities)
    .innerJoin(identities, eq(externalIdentities.identityId, identities.id))
    .where(and(eq(externalIdentities.issuer, issuer), eq(externalIdentities.subject, subject)));
  return row ? { ...row, kind: row.kind as "human" | "agent" } : null;
}
