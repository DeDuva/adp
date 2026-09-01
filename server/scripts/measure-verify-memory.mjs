// What verifying a long trajectory costs in memory, measured rather than
// modelled.
//
//   make measure-verify                 # 50,000 events, the default
//   SEED_N=200000 make measure-verify
//
// #152 asked for bounded peak memory "with the number in the PR". This is the
// tool that produced it, committed for the same reason `measure-operations-plans.mjs`
// is: so the next person to touch the read pattern can re-run rather than
// re-argue. Needs DATABASE_URL — `make up` provides one.
//
// It builds a throwaway database with the columns `verifyChain` actually reads,
// seeds one session, and runs both read patterns against it under
// `--expose-gc`: the old one (select the whole session, iterate the array) and
// the new one (keyset-paginate in batches of VERIFY_BATCH_SIZE). Peak RSS is
// sampled on a timer, because the allocation that matters is the one the driver
// makes while materialising rows and it is gone before any single measurement
// after the loop.
//
// It deliberately does NOT import the server's own verifyChain. Measuring the
// two patterns side by side requires the old one, which no longer exists in the
// tree — so both are written out here, and what is compared is the read shape
// rather than the hashing, which is identical in each.
import { Pool } from "pg";
import crypto from "node:crypto";

const N = Number(process.env.SEED_N ?? 50000);
// Roughly what a `tool_call` payload weighs once #199's structural projection
// has taken the strings out: the point is a payload with shape, not a number.
const PAYLOAD_BYTES = Number(process.env.PAYLOAD_BYTES ?? 600);
const BATCH = Number(process.env.VERIFY_BATCH_SIZE ?? 500);

if (!process.env.DATABASE_URL) {
  console.error("measure-verify: DATABASE_URL is not set — run `make up` first.");
  process.exit(1);
}
if (typeof globalThis.gc !== "function") {
  console.error("measure-verify: run under `node --expose-gc` (the make target does).");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const hashOf = (sessionId, prev, row) =>
  crypto
    .createHash("sha256")
    .update(canonical({ v: 1, sessionId, prev, seq: row.seq, payload: row.payload }), "utf8")
    .digest("hex");

// Samples RSS while `fn` runs. The peak is what bounds the box, and a reading
// taken after the loop has already missed it.
async function withPeakRss(fn) {
  globalThis.gc();
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 5);
  try {
    const started = process.hrtime.bigint();
    const result = await fn();
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    return { result, ms, peakOverBaselineBytes: peak - baseline };
  } finally {
    clearInterval(timer);
  }
}

// The read pattern as it was: one select, the whole session in an array.
async function verifyByLoading(p, sessionId) {
  const { rows } = await p.query(
    "select seq, payload, prev_hash, hash from session_events where session_id = $1 order by seq asc",
    [sessionId],
  );
  let prev = "genesis";
  for (const row of rows) {
    if (hashOf(sessionId, prev, row) !== row.hash) return { ok: false, at: row.seq };
    prev = row.hash;
  }
  return { ok: true, count: rows.length };
}

// The read pattern as it is: keyset pagination, one batch held at a time.
async function verifyByStreaming(p, sessionId, batchSize) {
  let prev = "genesis";
  let cursor = 0;
  let count = 0;
  for (;;) {
    const { rows } = await p.query(
      "select seq, payload, prev_hash, hash from session_events where session_id = $1 and seq > $2 order by seq asc limit $3",
      [sessionId, cursor, batchSize],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      if (hashOf(sessionId, prev, row) !== row.hash) return { ok: false, at: row.seq };
      prev = row.hash;
      count++;
    }
    cursor = rows[rows.length - 1].seq;
  }
  return { ok: true, count };
}

const mib = (bytes) => (bytes / 1024 / 1024).toFixed(1);

async function main() {
  const dbName = "measure_152_" + Date.now();
  await pool.query(`CREATE DATABASE "${dbName}"`);
  const target = new URL(process.env.DATABASE_URL);
  target.pathname = "/" + dbName;
  const p = new Pool({ connectionString: target.toString(), max: 2 });

  try {
    await p.query(`CREATE TABLE session_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid NOT NULL,
      seq integer NOT NULL,
      payload jsonb NOT NULL,
      prev_hash text NOT NULL,
      hash text NOT NULL)`);
    await p.query("CREATE UNIQUE INDEX ON session_events (session_id, seq)");

    const sessionId = crypto.randomUUID();
    console.log(`seeding ${N} events (~${PAYLOAD_BYTES} B payloads) in one session...`);

    // Chained in the client so the corpus actually verifies — a seed that does
    // not verify measures the cost of failing at event 1.
    let prev = "genesis";
    const filler = "x".repeat(Math.max(1, PAYLOAD_BYTES - 40));
    for (let start = 1; start <= N; start += 1000) {
      const values = [];
      const params = [];
      for (let seq = start; seq < Math.min(start + 1000, N + 1); seq++) {
        const payload = { step: seq, note: filler };
        const hash = hashOf(sessionId, prev, { seq, payload });
        const i = params.length;
        params.push(sessionId, seq, JSON.stringify(payload), prev, hash);
        values.push(`($${i + 1}::uuid, $${i + 2}, $${i + 3}::jsonb, $${i + 4}, $${i + 5})`);
        prev = hash;
      }
      await p.query(
        `INSERT INTO session_events (session_id, seq, payload, prev_hash, hash) VALUES ${values.join(",")}`,
        params,
      );
    }

    const stored = await p.query(
      "select pg_size_pretty(sum(pg_column_size(payload))) as bytes from session_events where session_id = $1",
      [sessionId],
    );
    console.log(`seeded. payload bytes on disk: ${stored.rows[0].bytes}\n`);

    const loaded = await withPeakRss(() => verifyByLoading(p, sessionId));
    const streamed = await withPeakRss(() => verifyByStreaming(p, sessionId, BATCH));

    if (!loaded.result.ok || !streamed.result.ok) {
      throw new Error(`seeded corpus does not verify: ${JSON.stringify({ loaded, streamed })}`);
    }
    if (loaded.result.count !== streamed.result.count) {
      throw new Error("the two patterns disagree on how many events they read");
    }

    console.log(`events verified:            ${streamed.result.count}`);
    console.log(`batch size:                 ${BATCH}\n`);
    console.log(`load-whole-session  peak RSS over baseline: ${mib(loaded.peakOverBaselineBytes)} MiB   ${loaded.ms.toFixed(0)} ms`);
    console.log(`batched (${String(BATCH).padEnd(5)})     peak RSS over baseline: ${mib(streamed.peakOverBaselineBytes)} MiB   ${streamed.ms.toFixed(0)} ms`);

    const ratio = loaded.peakOverBaselineBytes / Math.max(1, streamed.peakOverBaselineBytes);
    console.log(`\nratio: ${ratio.toFixed(1)}x less peak memory at N=${streamed.result.count}.`);
    console.log("re-run with SEED_N to see how each side moves: the loading side tracks the");
    console.log("session, the batched side tracks allocation churn the collector has not");
    console.log("caught up with — neither is retained, and only one is bounded by the batch.");
  } finally {
    await p.end();
    await pool.query(`DROP DATABASE "${dbName}"`);
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
