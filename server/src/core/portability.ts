import { and, asc, eq, getTableColumns, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  archivedKeys,
  changes,
  gateResults,
  identities,
  intents,
  issues,
  operations,
  proposals,
  runs,
} from "../db/schema.js";
import { recordOperation } from "./operations.js";
import type { KeyRegistry } from "./signing.js";

// A repository's record, leaving the instance that holds it.
//
// **`PUBLIC_URL` is part of the signed record rather than a display string.**
// The server signs evidence with it and hands it back in clone URLs, and
// `docs/self-hosting.md` states that as a property of the design and warns
// operators to decide it before the first change lands. The consequence nobody
// had written down is that the record could not move — and every adoption story
// in this phase ends with a developer's record living on an instance chosen
// while they were evaluating alone. If it cannot move when their company
// adopts, the funnel breaks precisely where it is supposed to pay off, for a
// reason that was designed in.
//
// **Nothing is re-signed, and that is the decision.** The honest answers were a
// small set: re-sign under the new instance and record the migration; keep the
// original signatures and carry the old key's public half; or accept that
// history verifies only against an archived key. The second is the one taken,
// because a signature says "this instance attested this, then" — re-signing
// would let the receiving instance assert what it did not witness, which is
// exactly the substitution this product exists to prevent. The third is what
// the second *is*, done properly.
//
// **Git is not in the bundle, and that is a boundary rather than an omission.**
// A change record references a commit; the commit travels by `git push`, which
// is the tool that exists for moving git history and is better at it than any
// serialisation here would be. The bundle carries what git cannot: the
// intents, the provenance, the signatures, the evidence and the operation log.

/** The bundle version, so a future shape change is a refusal rather than a misread. */
export const EXPORT_FORMAT = "adp.repository.export/v1";

export interface ExportBundle {
  format: string;
  exported_at: string;
  /** Who attested everything below. The receiving instance keeps this to verify with. */
  instance: { public_url: string; signing_public_key: string };
  repository: { owner: string; name: string; default_branch: string };
  /**
   * The principals the record names.
   *
   * Not a nicety: `operations.actorId`, `issues.authorId`, `proposals.authorId`,
   * `runs.actorId` and `gateResults.reporterId` are all hard foreign keys, so a
   * bundle without these is one the receiving instance cannot insert. The
   * alternative — rewriting every actor to whoever ran the import — would make
   * the log say that one person did everything, which is a falsified record
   * rather than a migrated one.
   *
   * Id, kind and principal only. No tokens, no external-identity links, no
   * memberships: what moves is who the record *names*, not the ability to act
   * as them.
   */
  identities: unknown[];
  intents: unknown[];
  issues: unknown[];
  proposals: unknown[];
  changes: unknown[];
  gate_results: unknown[];
  runs: unknown[];
  operations: unknown[];
}

export async function exportRepository(
  db: Db,
  repo: { id: string; owner: string; name: string; defaultBranch: string },
  instance: { publicUrl: string; signingPublicKey: string },
): Promise<ExportBundle> {
  // Ordered by creation throughout, so an export is byte-stable for the same
  // database state — which is what makes "did this bundle change?" a diff
  // rather than a set comparison.
  const [intentRows, issueRows, proposalRows, changeRows, gateRows, runRows, operationRows] = await Promise.all([
    db.select().from(intents).where(eq(intents.repoId, repo.id)).orderBy(asc(intents.createdAt)),
    db.select().from(issues).where(eq(issues.repoId, repo.id)).orderBy(asc(issues.number)),
    db.select().from(proposals).where(eq(proposals.repoId, repo.id)).orderBy(asc(proposals.number)),
    db.select().from(changes).where(eq(changes.repoId, repo.id)).orderBy(asc(changes.createdAt)),
    db.select().from(gateResults).where(eq(gateResults.repoId, repo.id)).orderBy(asc(gateResults.createdAt)),
    db.select().from(runs).where(eq(runs.repoId, repo.id)).orderBy(asc(runs.createdAt)),
    db.select().from(operations).where(eq(operations.repoId, repo.id)).orderBy(asc(operations.createdAt)),
  ]);

  // Everyone the record names, and nobody else. Gathered from the rows above
  // rather than from the identities table, so an export carries the principals
  // this repository's history mentions and not the instance's whole roster.
  const actorIds = new Set<string>(
    [
      ...operationRows.map((r) => r.actorId),
      ...issueRows.map((r) => r.authorId),
      ...proposalRows.map((r) => r.authorId),
      ...runRows.map((r) => r.actorId),
      ...gateRows.map((r) => r.reporterId),
    ].filter((id): id is string => !!id),
  );
  const identityRows =
    actorIds.size === 0
      ? []
      : await db
          .select({ id: identities.id, kind: identities.kind, principal: identities.principal })
          .from(identities)
          .where(inArray(identities.id, [...actorIds]));

  return {
    format: EXPORT_FORMAT,
    exported_at: new Date().toISOString(),
    // The key is the whole point of the bundle being portable at all: without
    // it, every signature and every DSSE envelope below is unverifiable on the
    // receiving instance, and an unverifiable record is not evidence.
    instance: { public_url: instance.publicUrl, signing_public_key: instance.signingPublicKey },
    repository: { owner: repo.owner, name: repo.name, default_branch: repo.defaultBranch },
    identities: identityRows,
    intents: intentRows,
    issues: issueRows,
    proposals: proposalRows,
    changes: changeRows,
    gate_results: gateRows,
    runs: runRows,
    operations: operationRows,
  };
}

export interface ImportResult {
  ok: true;
  repoId: string;
  counts: Record<string, number>;
  /** True when the exporting instance's key was new here. */
  keyArchived: boolean;
}

export interface ImportRefusal {
  ok: false;
  status: number;
  message: string;
}

/**
 * Take a bundle in, keeping every signature exactly as it was.
 *
 * Idempotent by row: everything is inserted `onConflictDoNothing`, so importing
 * the same bundle twice is a no-op rather than a duplicate history. That is not
 * politeness — a migration that half-failed has to be safe to run again, and an
 * import which is only safe once is one nobody will retry when they most need
 * to.
 *
 * The ids are preserved. A record whose operations point at renumbered rows is
 * a record that no longer says what it said, and the ids are uuids precisely so
 * that carrying them across instances is safe.
 */
export async function importRepository(
  db: Db,
  bundle: ExportBundle,
  repo: { id: string; owner: string; name: string },
  actorId: string,
  registry?: KeyRegistry,
): Promise<ImportResult | ImportRefusal> {
  if (bundle.format !== EXPORT_FORMAT) {
    // Refused by name rather than parsed hopefully. A bundle in a shape this
    // does not know is one whose signatures this cannot promise to preserve,
    // and a half-understood import is worse than none.
    return {
      ok: false,
      status: 422,
      message: `unknown bundle format '${bundle.format}' — this instance reads ${EXPORT_FORMAT}`,
    };
  }
  if (!bundle.instance?.signing_public_key || !bundle.instance.public_url) {
    return {
      ok: false,
      status: 422,
      message:
        "the bundle names no signing key — without the exporting instance's public key every " +
        "signature in it is unverifiable here, and an unverifiable record is not evidence",
    };
  }

  const counts: Record<string, number> = {};
  const keyArchived = await db.transaction(async (tx) => {
    // The key first. If anything below fails, an archived key with no records
    // is harmless; records with no key are unverifiable, which is the failure
    // this whole item exists to prevent.
    const archived = await tx
      .insert(archivedKeys)
      .values({
        publicKeyHex: bundle.instance.signing_public_key,
        publicUrl: bundle.instance.public_url,
      })
      .onConflictDoNothing()
      .returning();

    // Order matters, and identities come first: every other table below has a
    // hard foreign key to them, and an import that inserted an operation before
    // its actor would fail on the row that says who did the work.
    counts.identities = await insertIdentities(tx, bundle.identities);
    counts.intents = await insertAll(tx, intents, bundle.intents, repo.id);
    counts.issues = await insertAll(tx, issues, bundle.issues, repo.id);
    counts.changes = await insertAll(tx, changes, bundle.changes, repo.id);
    counts.proposals = await insertAll(tx, proposals, bundle.proposals, repo.id);
    counts.gate_results = await insertAll(tx, gateResults, bundle.gate_results, repo.id);
    counts.runs = await insertAll(tx, runs, bundle.runs, repo.id);
    counts.operations = await insertAll(tx, operations, bundle.operations, repo.id);

    // The migration is itself an operation, which is the answer to "how did
    // these records get here" — a question the imported operations cannot
    // answer about themselves, because they were written somewhere else.
    await recordOperation(tx, {
      repoId: repo.id,
      actorId,
      verb: "repo.import",
      target: `${repo.owner}/${repo.name}`,
      after: {
        from: bundle.instance.public_url,
        signingPublicKey: bundle.instance.signing_public_key,
        exportedAt: bundle.exported_at,
        counts,
      },
    });

    return archived.length > 0;
  });

  // Live registry, so an imported record verifies on this process without a
  // restart. Boot loads the same rows — see routes.ts — and the two together
  // are what make "import it and it verifies" true rather than "import it,
  // then restart the server".
  if (registry) registry.add(bundle.instance.signing_public_key);

  return { ok: true, repoId: repo.id, counts, keyArchived };
}

/**
 * Insert rows verbatim, keeping their ids, skipping what is already here.
 *
 * `repoId` is rewritten to the receiving repository's and nothing else is
 * touched. That one rewrite is unavoidable — the row has to belong to a
 * repository that exists here — and it is safe because no signature covers it:
 * a change's signature is over `repo` as `owner/name`, its sha, its intent and
 * its provenance, none of which this moves.
 */
async function insertAll(
  tx: Pick<Db, "insert">,
  table: never | Parameters<Db["insert"]>[0],
  rows: unknown[],
  repoId: string,
): Promise<number> {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  // A bundle is JSON, so every timestamp arrived as a string and every column
  // that wants a Date would otherwise fail the insert. Coerced from the table's
  // own column metadata rather than from a hand-kept list of field names: a
  // list is a thing that goes stale the first time a table grows a column, and
  // it would go stale silently — the insert fails at runtime, on a migration,
  // which is the worst place to find out.
  const columns = getTableColumns(table as never) as Record<string, { dataType?: string }>;
  const dateColumns = new Set(
    Object.entries(columns)
      .filter(([, column]) => column.dataType === "date")
      .map(([name]) => name),
  );

  const values = rows.map((row) => {
    const out: Record<string, unknown> = { ...(row as Record<string, unknown>), repoId };
    for (const key of dateColumns) {
      const value = out[key];
      if (typeof value === "string") out[key] = new Date(value);
    }
    return out;
  });
  const inserted = await tx
    .insert(table)
    .values(values as never)
    .onConflictDoNothing()
    .returning();
  return (inserted as unknown[]).length;
}

/**
 * The principals the record names, inserted with their ids intact.
 *
 * Not repo-scoped — identities are instance-level — so this is the one insert
 * here that does not rewrite anything. An id that already exists is the same
 * person already known, which is the ordinary case when two repositories move
 * from the same instance, and it is skipped rather than merged: this route
 * takes records in, and reconciling two instances' notions of one person is a
 * different problem with a different answer.
 */
async function insertIdentities(tx: Pick<Db, "insert">, rows: unknown[]): Promise<number> {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const inserted = await tx
    .insert(identities)
    .values(rows as never)
    .onConflictDoNothing()
    .returning();
  return inserted.length;
}

/** Every key this instance has taken in, for the registry to load at boot. */
export async function loadArchivedKeys(db: Db): Promise<string[]> {
  const rows = await db.select({ hex: archivedKeys.publicKeyHex }).from(archivedKeys);
  return rows.map((r) => r.hex);
}

/** Where a record came from, for a reader of an imported bundle. */
export async function findArchivedKey(db: Db, publicKeyHex: string) {
  const [row] = await db
    .select()
    .from(archivedKeys)
    .where(and(eq(archivedKeys.publicKeyHex, publicKeyHex)));
  return row ?? null;
}
