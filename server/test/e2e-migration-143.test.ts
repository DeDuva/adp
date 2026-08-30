import { describe, it, expect } from "vitest";
import { skipWithoutDb } from "./require-db.js";
import { cp, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "../src/db/client.js";

const MIGRATIONS = new URL("../drizzle", import.meta.url).pathname;
const TAG = "0030_fix_143_changes_unique_repo_sha";

// #143's migration has to resolve duplicates rather than fail the deploy on
// them, which means the only honest proof is a database that already holds
// them. Every other test in this tier runs against a database that is already
// fully migrated, so this one builds its own: a throwaway database migrated to
// the state *before* 0030, seeded with the exact duplicate shape the bug
// produced, and then migrated the rest of the way.
//
// The pre-0030 state comes from a copy of `drizzle/` with 0030 removed from
// the journal — so the migration under test is the one that ships, byte for
// byte, rather than a transcription of it into the test.
describe.skipIf(skipWithoutDb)("#143: the unique index migrates a database that already holds duplicates", () => {
  it("keeps the bound row, repoints the proposal at it, and drops the sibling", async () => {
    const admin = new Pool({ connectionString: process.env.DATABASE_URL! });
    const dbName = `adp_mig_143_${Date.now()}_${process.pid}`;
    const target = new URL(process.env.DATABASE_URL!);
    target.pathname = `/${dbName}`;

    let staging: string | null = null;
    let pool: Pool | null = null;
    try {
      await admin.query(`CREATE DATABASE "${dbName}"`);

      // 1. Migrate to the state immediately before 0030.
      staging = await mkdtemp(path.join(tmpdir(), "adp-mig-143-"));
      await cp(MIGRATIONS, staging, { recursive: true });
      const journalPath = path.join(staging, "meta", "_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
      const targetAt = journal.entries.findIndex((entry) => entry.tag === TAG);
      expect(targetAt).toBeGreaterThan(-1);
      // *Truncate* at the target rather than filtering it out. Removing only
      // this one entry worked until a later migration existed, and then stopped
      // silently: drizzle applies migrations whose timestamp is newer than the
      // last one applied, so a run that reached 0031 would never come back for
      // 0030 — the staged database would arrive already "past" the migration
      // under test, and this test would assert against a table it had never
      // touched. Truncating is also what "the state before this migration"
      // actually means.
      const priorEntries = journal.entries.slice(0, targetAt);
      await writeFile(journalPath, JSON.stringify({ ...journal, entries: priorEntries }, null, 2));

      const before = createDb(target.toString());
      await migrate(before.db, { migrationsFolder: staging });
      await before.pool.end();

      const db = createDb(target.toString());
      pool = db.pool;

      // 2. Seed the duplicate shape the bug produced: an unbound row the push
      //    auto-recorded, and a bound sibling the explicit POST inserted
      //    beside it. Plus a repo whose single change must survive untouched,
      //    so the migration is shown to delete only what it must.
      const seeded = await pool.query<{
        unbound: string;
        bound: string;
        untouched: string;
        proposal: string;
      }>(`
        WITH o AS (INSERT INTO orgs (name) VALUES ('mig143') RETURNING id),
             r AS (
               INSERT INTO repos (owner, name, org_id)
               SELECT 'mig143', 'widget', o.id FROM o RETURNING id
             ),
             i AS (INSERT INTO identities (kind, principal) VALUES ('human', 'mig143') RETURNING id),
             intent AS (
               INSERT INTO intents (repo_id, title, source)
               SELECT r.id, 'bound', 'api' FROM r RETURNING id
             ),
             unbound AS (
               INSERT INTO changes (repo_id, git_sha, intent_id, provenance, signature, created_at)
               SELECT r.id, repeat('a', 40), NULL, '{"via":"push"}'::jsonb, 'sig-push', now() - interval '2 minutes'
               FROM r RETURNING id
             ),
             bound AS (
               INSERT INTO changes (repo_id, git_sha, intent_id, provenance, signature, created_at)
               SELECT r.id, repeat('a', 40), intent.id, '{"via":"explicit"}'::jsonb, 'sig-bound', now()
               FROM r, intent RETURNING id
             ),
             untouched AS (
               INSERT INTO changes (repo_id, git_sha, intent_id, provenance, signature)
               SELECT r.id, repeat('b', 40), NULL, '{"via":"push"}'::jsonb, 'sig-other' FROM r RETURNING id
             ),
             proposal AS (
               INSERT INTO proposals (repo_id, number, title, head_ref, head_sha, base_ref, change_id, author_id)
               SELECT r.id, 1, 'p', 'topic', repeat('a', 40), 'main', unbound.id, i.id
               FROM r, i, unbound RETURNING id
             )
        SELECT unbound.id AS unbound, bound.id AS bound, untouched.id AS untouched,
               proposal.id AS proposal
        FROM unbound, bound, untouched, proposal
      `);
      const { unbound, bound, untouched, proposal } = seeded.rows[0]!;

      // 3. Apply 0030 itself.
      await migrate(db.db, { migrationsFolder: MIGRATIONS });

      // The bound row wins: the binding is the fact worth keeping.
      const survivors = await pool.query<{ id: string }>(
        `SELECT id FROM changes WHERE git_sha = repeat('a', 40) ORDER BY id`,
      );
      expect(survivors.rows.map((row) => row.id)).toEqual([bound]);

      // proposals.change_id is the one FK into this table — the proposal that
      // pointed at the losing row is repointed rather than orphaned, and the
      // delete is therefore not blocked by it either.
      const repointed = await pool.query<{ change_id: string }>(`SELECT change_id FROM proposals WHERE id = $1`, [
        proposal,
      ]);
      expect(repointed.rows[0]!.change_id).toBe(bound);
      expect(repointed.rows[0]!.change_id).not.toBe(unbound);

      // A sha with one row is a sha the migration must not touch.
      const other = await pool.query<{ id: string }>(`SELECT id FROM changes WHERE git_sha = repeat('b', 40)`);
      expect(other.rows.map((row) => row.id)).toEqual([untouched]);

      // And the constraint is real afterwards, which is what stops the bug
      // coming back through a write path nobody has written yet.
      const index = await pool.query<{ indisunique: boolean }>(
        `SELECT indisunique FROM pg_index WHERE indexrelid = 'changes_repo_id_git_sha_idx'::regclass`,
      );
      expect(index.rows[0]!.indisunique).toBe(true);

      await expect(
        pool.query(
          `INSERT INTO changes (repo_id, git_sha, provenance, signature)
           SELECT repo_id, git_sha, '{}'::jsonb, 'nope' FROM changes WHERE id = $1`,
          [bound],
        ),
      ).rejects.toThrow(/changes_repo_id_git_sha_idx/);
    } finally {
      await pool?.end();
      if (staging) await rm(staging, { recursive: true, force: true });
      // A connection still open to the database blocks the drop, and leaving
      // a throwaway database behind is exactly what `make down` asserts
      // against.
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  });
});
