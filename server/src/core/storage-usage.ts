import { sql, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "./git-backend.js";
import { orgs, repos } from "../db/schema.js";
import { withTickLock, TICK_LOCKS } from "./tick-lock.js";
import { findRepo } from "./repos-lookup.js";
import { setStorageGauges } from "./telemetry.js";

// M4-3's storage quota — the half of the milestone that was deferred to M4-8
// while M4-8's own sizing waited on this quota's shape existing to bound it.
// The deadlock is broken by metering what is actually on this machine today
// rather than waiting for an object store to meter against: an org's bytes
// are the rows it owns in Postgres plus the git repos it owns on disk, and
// they gain a third term the day a CAS exists without the ceiling's shape
// changing.
//
// Two properties this meter deliberately does NOT have, stated here because
// both are the kind of thing a reader would otherwise assume:
//
//  1. It is not exact. `pg_column_size(t.*)` is the size of the row datum —
//     post-compression for anything TOAST compressed, which is the number an
//     operator cares about — but it excludes index tuples, per-page overhead,
//     and dead-tuple bloat. The instance-wide truth is
//     `pg_total_relation_size`; that figure cannot be attributed to an org,
//     which is the whole problem a per-tenant meter has. So this counts the
//     bytes an org *put there*, not the bytes its share of the cluster
//     occupies, and it will read low against `\dt+`.
//  2. It is not synchronous. Enforcement reads `orgs.storage_bytes_used`,
//     written by the tick below. Counting on every append would put these
//     scans in the trajectory hot path, which is the one path the storage
//     analysis measured as the dominant source of growth in the first place.

// Every table whose rows an org can grow without bound, and how each one
// reaches an org. Kept as data rather than nine hand-written queries so that
// adding a table to the meter is one row — the failure mode this guards
// against is a new high-volume table shipping and silently not being counted,
// which is exactly how a quota stops meaning anything.
//
// `operations` is the one irregular case: it carries both `org_id` (set on
// org-level operations by #97) and `repo_id`, and the audit export already
// treats those as an OR. The meter agrees with the export rather than
// inventing a second definition of "this org's operations".
const POSTGRES_SOURCES: readonly { table: string; from: string; where: string }[] = [
  { table: "repos", from: "repos t", where: "t.org_id = org.id" },
  { table: "changes", from: "changes t join repos r on r.id = t.repo_id", where: "r.org_id = org.id" },
  { table: "gate_results", from: "gate_results t join repos r on r.id = t.repo_id", where: "r.org_id = org.id" },
  { table: "gate_jobs", from: "gate_jobs t join repos r on r.id = t.repo_id", where: "r.org_id = org.id" },
  { table: "runs", from: "runs t join repos r on r.id = t.repo_id", where: "r.org_id = org.id" },
  { table: "workspaces", from: "workspaces t join repos r on r.id = t.repo_id", where: "r.org_id = org.id" },
  { table: "sessions", from: "sessions t join repos r on r.id = t.repo_id", where: "r.org_id = org.id" },
  {
    table: "session_events",
    from: "session_events t join sessions s on s.id = t.session_id join repos r on r.id = s.repo_id",
    where: "r.org_id = org.id",
  },
  {
    table: "checkpoints",
    from: "checkpoints t join sessions s on s.id = t.session_id join repos r on r.id = s.repo_id",
    where: "r.org_id = org.id",
  },
  {
    table: "operations",
    from: "operations t left join repos r on r.id = t.repo_id",
    where: "(t.org_id = org.id or r.org_id = org.id)",
  },
];

// The org id is bound once, in a CTE the ten branches all read, rather than
// interpolated ten times into the SQL text. Every id this runs with today
// comes from `orgs.id` and is already a uuid, but a meter is not worth a
// string-concatenated query — and the CTE is also how the branches stay
// readable enough to check by eye.
const POSTGRES_BYTES_TAIL = ` select coalesce(sum(bytes), 0)::bigint as bytes from (
${POSTGRES_SOURCES.map(
  (s) => `  select sum(pg_column_size(t.*)) as bytes from org, ${s.from} where ${s.where}`,
).join("\n  union all\n")}
) totals`;

export interface OrgStorage {
  postgresBytes: number;
  gitBytes: number;
  totalBytes: number;
}

// Measures one org from scratch. Expensive by construction — it is a full
// scan of that org's rows in ten tables — which is why it belongs on a tick
// and not on a request path.
export async function measureOrgStorage(db: Db, gitBackend: GitBackend, orgId: string): Promise<OrgStorage> {
  const result = await db.execute(
    sql`with org as (select ${orgId}::uuid as id)`.append(sql.raw(POSTGRES_BYTES_TAIL)),
  );
  const postgresBytes = Number((result.rows[0] as { bytes?: string | number } | undefined)?.bytes ?? 0);

  const owned = await db
    .select({ owner: repos.owner, name: repos.name })
    .from(repos)
    .where(eq(repos.orgId, orgId));

  let gitBytes = 0;
  for (const repo of owned) {
    gitBytes += await gitBackend.diskUsageBytes(repo.owner, repo.name);
  }

  return { postgresBytes, gitBytes, totalBytes: postgresBytes + gitBytes };
}

// Measures every org and writes the reading. Returns per-org results so the
// caller (and the test) can see what was measured rather than only that
// something was.
export async function meterAllOrgs(
  db: Db,
  gitBackend: GitBackend,
  now: () => Date = () => new Date(),
): Promise<{ orgId: string; totalBytes: number }[]> {
  const all = await db.select({ id: orgs.id, name: orgs.name }).from(orgs);
  const measured: { orgId: string; totalBytes: number }[] = [];
  const gauges: { org: string; bytes: number }[] = [];

  for (const org of all) {
    // One org's broken repo directory must not stop every org after it from
    // being metered — the same wedge workspace-sweeper.ts fixed, and it
    // matters more here: a meter that stops running leaves enforcement
    // reading an ever-staler number while still believing it.
    try {
      const storage = await measureOrgStorage(db, gitBackend, org.id);
      await db
        .update(orgs)
        .set({ storageBytesUsed: storage.totalBytes, storageMeasuredAt: now() })
        .where(eq(orgs.id, org.id));
      measured.push({ orgId: org.id, totalBytes: storage.totalBytes });
      gauges.push({ org: org.name, bytes: storage.totalBytes });
    } catch (err) {
      console.error(`storage meter failed for org ${org.id}:`, err);
    }
  }

  // Only orgs this pass actually measured. An org whose measurement threw is
  // left out rather than carried forward at its old value: a gauge that keeps
  // reporting a stale number for a repo directory that has gone missing is
  // worse than a series that stops, because only one of the two is visible on
  // a dashboard.
  setStorageGauges(gauges);
  return measured;
}

// The tick the interval actually runs, behind the same advisory lock every
// other periodic job in this codebase uses (#96). Null means another replica
// held it and this tick correctly did nothing — metering twice concurrently
// is not harmful, just wasted full scans.
export async function storageMeterTick(
  db: Db,
  gitBackend: GitBackend,
): Promise<{ orgId: string; totalBytes: number }[] | null> {
  return await withTickLock(db, TICK_LOCKS.storageMeter, () => meterAllOrgs(db, gitBackend));
}

export function startStorageMeter(db: Db, gitBackend: GitBackend, intervalMs: number): () => void {
  const timer = setInterval(() => {
    void storageMeterTick(db, gitBackend).catch((err) => {
      console.error("storage meter tick failed:", err);
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export type StorageQuotaCheck =
  | { ok: true }
  | { ok: false; limit: number; used: number; measuredAt: Date | null };

// The check every growth path runs. Reads the meter's last reading, never
// measures — see the note at the top of this file.
//
// An org with no ceiling, or one that has never been measured, is under
// quota. The second is the deliberate one: `storage_bytes_used` is null until
// the first tick, and treating null as "unknown, therefore refuse" would make
// every instance refuse every write for the first interval after a deploy.
// Failing open on an unmeasured org costs at most one interval of overshoot;
// failing closed costs an outage on every restart.
export async function checkStorageQuota(db: Db, orgId: string | null): Promise<StorageQuotaCheck> {
  if (!orgId) return { ok: true };

  const [org] = await db
    .select({
      limit: orgs.maxStorageBytes,
      used: orgs.storageBytesUsed,
      measuredAt: orgs.storageMeasuredAt,
    })
    .from(orgs)
    .where(eq(orgs.id, orgId));

  if (!org || org.limit == null || org.used == null) return { ok: true };
  if (org.used < org.limit) return { ok: true };
  return { ok: false, limit: org.limit, used: org.used, measuredAt: org.measuredAt };
}

// The message every refusal uses, so the four call sites cannot drift into
// four different phrasings of the same 403.
export function storageQuotaMessage(check: Extract<StorageQuotaCheck, { ok: false }>): string {
  return `Org storage quota exceeded (${check.used} of ${check.limit} bytes used)`;
}

// The git proxy's PushQuotaCheck, built from the Db. Same factory shape as
// repos-lookup.ts's repoAccessCheck, and for the same reason: the proxy takes
// a callback so its wire-fidelity suite needs no Postgres.
//
// A push to a path with no repo row is allowed through — the proxy's own
// on-disk existence check and authorization already ran, and a meter is not
// the place to invent a fourth answer to "does this repo exist".
export function pushQuotaCheck(db: Db) {
  return async (owner: string, name: string): Promise<{ ok: true } | { ok: false; message: string }> => {
    const repo = await findRepo(db, owner, name);
    if (!repo) return { ok: true };
    const check = await checkStorageQuota(db, repo.orgId);
    return check.ok ? { ok: true } : { ok: false, message: storageQuotaMessage(check) };
  };
}
