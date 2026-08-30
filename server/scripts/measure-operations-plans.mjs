// What `operations` costs to read, measured rather than modelled.
//
//   make measure-ops              # 1M rows, the default
//   SEED_N=5000000 make measure-ops
//
// #147 asked for the index set to be chosen from query plans at the volume
// ambient capture (#149) implies, not from the shape of the table. This is the
// tool that produced those numbers, committed so a reader can reproduce them
// and so the next person to touch these indexes can re-run rather than re-argue.
//
// It builds a throwaway database with just the columns the two readers touch,
// seeds it, and reports EXPLAIN (ANALYZE, BUFFERS) for each query shape under
// each candidate index set. Needs DATABASE_URL — `make up` provides one.
//
// Two things the seeding gets deliberately right, because the first attempt
// got them wrong and produced a misleading answer:
//
//   - repo, actor and verb are assigned randomly, not by modulo. Modulo
//     correlated them, so some (repo, verb) pairs never co-occurred and the
//     "filter by a selective verb" shape was measuring a query that could
//     never match rather than one that rarely matches.
//   - verbs are skewed 90/10 toward one hot verb, like a real log after
//     ambient capture. A uniform distribution makes every filter look
//     selective and flatters the index.
import { Pool } from "pg";
import crypto from "node:crypto";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const N = Number(process.env.SEED_N ?? 1000000);
const REPOS = 20;
const VERBS = ["change.create", "proposal.merge", "gate.report", "token.mint", "session.event", "workspace.create"];

async function main() {
  const db = "measure_147_" + Date.now();
  await pool.query(`CREATE DATABASE "${db}"`);
  const t = new URL(process.env.DATABASE_URL); t.pathname = "/" + db;
  const p = new Pool({ connectionString: t.toString() });
  try {
    // Only the columns the queries touch — this measures index behaviour on
    // `operations`, not the FK graph around it.
    await p.query(`CREATE TABLE operations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      repo_id uuid, org_id uuid, actor_id uuid NOT NULL,
      verb text NOT NULL, target text NOT NULL,
      before jsonb, after jsonb, parent_op uuid,
      created_at timestamptz NOT NULL DEFAULT now())`);

    const repoIds = Array.from({ length: REPOS }, () => crypto.randomUUID());
    const orgId = crypto.randomUUID();
    const actorIds = Array.from({ length: 8 }, () => crypto.randomUUID());
    console.log(`seeding ${N} rows across ${REPOS} repos...`);
    await p.query(`
      INSERT INTO operations (repo_id, org_id, actor_id, verb, target, after, created_at)
      SELECT
        CASE WHEN i % 50 = 0 THEN NULL ELSE ($1::uuid[])[1 + floor(random() * ${REPOS})::int] END,
        CASE WHEN i % 50 = 0 THEN $2::uuid ELSE NULL END,
        ($3::uuid[])[1 + floor(random() * 8)::int],
        CASE WHEN random() < 0.9 THEN 'session.event' ELSE ($4::text[])[1 + floor(random() * ${VERBS.length})::int] END,
        'acme/widget@' || md5(i::text),
        '{"k":"v"}'::jsonb,
        now() - (i || ' seconds')::interval
      FROM generate_series(1, ${N}) i`, [repoIds, orgId, actorIds, VERBS]);

    // The index set as it stands today.
    await p.query(`CREATE INDEX operations_repo_id_idx ON operations (repo_id)`);
    await p.query("ANALYZE operations");

    const target = repoIds[0];
    const rareVerb = "token.mint";
    const actor = actorIds[0];

    const shapes = {
      "history: repo + sort": {
        sql: `SELECT * FROM operations WHERE repo_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`,
        args: [target],
      },
      "history: repo + verb + sort": {
        sql: `SELECT * FROM operations WHERE repo_id = $1 AND verb = $2 ORDER BY created_at DESC, id DESC LIMIT 50`,
        args: [target, rareVerb],
      },
      "history: repo + actor + since + sort": {
        sql: `SELECT * FROM operations WHERE repo_id = $1 AND actor_id = $2 AND created_at >= now() - interval '2 days' ORDER BY created_at DESC, id DESC LIMIT 50`,
        args: [target, actor],
      },
      "export: OR(repo IN (...), org) + sort": {
        sql: `SELECT * FROM operations WHERE (repo_id = ANY($1) OR org_id = $2) ORDER BY created_at DESC, id DESC LIMIT 200`,
        args: [repoIds, orgId],
      },
    };

    async function report(label, shapeSet) {
      console.log(`\n===== ${label} =====`);
      for (const [name, q] of Object.entries(shapeSet)) {
        const r = await p.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.sql}`, q.args);
        const plan = r.rows[0]["QUERY PLAN"][0];
        const nodes = [...new Set((JSON.stringify(plan.Plan).match(/"Node Type":"[^"]+"/g) ?? []).map((s) => s.split('"')[3]))];
        const blocks = plan.Plan["Shared Hit Blocks"] + plan.Plan["Shared Read Blocks"];
        console.log(`${name}`);
        console.log(`  ${plan["Execution Time"].toFixed(1)} ms | ${blocks} blocks | ${nodes.join(", ")}`);
      }
    }

    await report("BEFORE — one index on (repo_id)", shapes);

    // The proposed set: the leading column is the always-present predicate and
    // the rest is the sort key, so filter+sort becomes one ordered index walk
    // with no Sort node.
    await p.query(`DROP INDEX operations_repo_id_idx`);
    await p.query(`CREATE INDEX operations_repo_id_created_at_idx ON operations (repo_id, created_at DESC, id DESC)`);
    await p.query(`CREATE INDEX operations_org_id_created_at_idx ON operations (org_id, created_at DESC, id DESC)`);
    await p.query("ANALYZE operations");

    // The export, restructured: two indexed reads unioned, each ordered and
    // bounded, rather than one predicate no index can serve.
    const unioned = {
      "export: UNION ALL of two indexed reads": {
        sql: `SELECT * FROM (
                (SELECT * FROM operations WHERE repo_id = ANY($1) ORDER BY created_at DESC, id DESC LIMIT 200)
                UNION ALL
                (SELECT * FROM operations WHERE org_id = $2 ORDER BY created_at DESC, id DESC LIMIT 200)
              ) u ORDER BY created_at DESC, id DESC LIMIT 200`,
        args: [repoIds, orgId],
      },
    };
    await report("AFTER — (repo_id, created_at DESC, id DESC) + (org_id, …)", { ...shapes, ...unioned });

    // The structural alternative: stop making the export ask an un-indexable
    // question. If every operation carries the org it belongs to — repo-scoped
    // ones included — the OR disappears and the export is one ordered read.
    await p.query(`UPDATE operations SET org_id = $1 WHERE repo_id IS NOT NULL AND org_id IS NULL`, [orgId]);
    await p.query("ANALYZE operations");
    // The alternative that denormalizes nothing: one indexed ordered scan per
    // repo, bounded by LIMIT, merged. Postgres will not derive this from
    // `repo_id = ANY(…)` on its own, but written as a LATERAL it is R+1
    // indexed reads of at most `limit` rows each.
    await report("AFTER — LATERAL per-repo, no denormalization", {
      "export: LATERAL over the org's repos": {
        sql: `SELECT * FROM (
                SELECT o.* FROM unnest($1::uuid[]) AS r(id)
                CROSS JOIN LATERAL (
                  SELECT * FROM operations WHERE repo_id = r.id
                  ORDER BY created_at DESC, id DESC LIMIT 200
                ) o
                UNION ALL
                (SELECT * FROM operations WHERE org_id = $2 ORDER BY created_at DESC, id DESC LIMIT 200)
              ) u ORDER BY created_at DESC, id DESC LIMIT 200`,
        args: [repoIds, orgId],
      },
    });

    await report("AFTER — org_id carried on every operation", {
      "export: org_id = $1 + sort": {
        sql: `SELECT * FROM operations WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`,
        args: [orgId],
      },
    });

    // And whether the selective-verb case justifies its own index.
    await p.query(`CREATE INDEX operations_repo_verb_created_at_idx ON operations (repo_id, verb, created_at DESC, id DESC)`);
    await p.query("ANALYZE operations");
    await report("AFTER — plus (repo_id, verb, created_at DESC, id DESC)", {
      "history: repo + verb + sort": shapes["history: repo + verb + sort"],
      "history: repo + sort (regression check)": shapes["history: repo + sort"],
    });


  } finally {
    await p.end();
    await pool.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => {});
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
