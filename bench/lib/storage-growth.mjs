// Arm 4 of the benchmark: storage growth (PLAN.md 3-5, #195).
//
// 3-6's retention and tiering policy has a settled shape and no numbers. The
// 2026-08-22 storage analysis *modelled* growth from 1,930 real trajectory
// events; this arm *measures* it, on a real Postgres, through the real server,
// so that a retention window and a tiering boundary can be argued from bytes
// rather than from a model of bytes.
//
// Deliberately model-free, on arm 1's terms rather than arms 2, 3 and 5's: no
// agent, no LLM call, no tokens. Every payload is generated from a seeded PRNG,
// so a re-run on the same Postgres writes the same payloads to the byte, and
// relation sizes within about half a percent single-writer and three percent
// under concurrent ingest (uuid keys and interleaving writers vary the order
// pages fill and indexes split in). The code the server's e2e suite drives at
// small N is this module — not a copy of it.
//
// What it measures, each against a database only this arm writes to:
//
//   1. Bytes per trajectory event, under both `trajectory.payloads` modes and
//      two content profiles that bracket compressibility (see below): heap,
//      TOAST and index bytes separately, as Postgres actually allocates them.
//   2. Realised vs batched compression: what TOAST achieves on these payloads
//      one datum at a time, against what compressing a recorder's batch would.
//   3. Dedup yield: how many stored bytes are copies — trajectory payloads, and
//      the SBOM every land records (#194).
//   4. The ingest curve: append throughput by decile of corpus size, with
//      concurrent writers, which is where a cliff would show.
//   5. Peak server RSS on `/verify`, whole-run and anchored at checkpoints.
//   6. Bytes per checkpoint, per operation row and per landed change.
//   7. How far the storage meter (core/storage-usage.ts) reads below what the
//      tables occupy — it counts row datums, by design, and a quota is set
//      against its number.
//
// **Why two content profiles.** The payloads here are synthetic, and a
// synthetic payload's compressibility is a choice, not a fact. So the arm does
// not pretend to have made it: `text` is code-and-prose-shaped text drawn from
// a Zipf-weighted vocabulary, which compresses the way source does, and
// `random` is six-bit random characters, which barely compresses at all. Real
// content sits between them, and every compression figure is reported for
// both, so the bracket is visible rather than a single flattering number.

import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";

// What `appendEvents` refuses above (core/payload-limits.ts), less headroom:
// a batch is flushed before it would cross this, exactly as a producer that
// respects the published limit has to.
const BATCH_PAYLOAD_BUDGET_BYTES = 900 * 1024;
// Largest single synthetic payload. Well under the 128 KiB per-event ceiling;
// the point of the tail is to push some rows past TOAST's ~2 KB threshold, not
// to probe the ceiling, which #146's own tests already pin.
const MAX_PAYLOAD_BYTES = 24 * 1024;

// The mean the storage analysis measured across 1,930 real events. Carried so
// the report can put the synthetic corpus beside it rather than leaving the
// reader to wonder how representative it is.
export const OBSERVED_MEAN_PAYLOAD_BYTES = 833;

// The recorder's own default batch (recorder/src/shipper.ts). Ingest is
// measured at the size the real producer sends, because throughput per batch
// is dominated by the per-request cost and a bigger batch flatters it.
export const RECORDER_BATCH_SIZE = 200;

export const DEFAULT_SCALE = Object.freeze({
  bytesEvents: 20_000,
  ingestEvents: 200_000,
  writers: 4,
  batchSize: RECORDER_BATCH_SIZE,
  checkpointEvery: 2_000,
  lands: 200,
});

// Small enough for every CI run, large enough that every code path runs:
// several batches per writer, a checkpoint per writer, more than one land.
export const CI_SCALE = Object.freeze({
  bytesEvents: 400,
  ingestEvents: 2_000,
  writers: 2,
  batchSize: RECORDER_BATCH_SIZE,
  checkpointEvery: 500,
  lands: 4,
});

// The tables this arm writes, and the ones the storage meter counts. Measured
// at the relation level (what Postgres allocates) and the row level (what the
// meter sums) so the two can be compared.
const TABLES = [
  "session_events",
  "checkpoints",
  "sessions",
  "runs",
  "operations",
  "changes",
  "proposals",
  "gate_results",
  "intents",
  "issues",
];

const BYTES_CONFIGS = [
  { mode: "structure", profile: "text" },
  { mode: "structure", profile: "random" },
  { mode: "full", profile: "text" },
  { mode: "full", profile: "random" },
];

// --- deterministic corpus ---------------------------------------------------

// mulberry32: tiny, fast, and identical on every platform, which is the only
// property that matters here.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  const u = Math.max(rand(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// Lognormal sizes: most payloads are small and a few are large, which is the
// shape tool output actually has — a `git status` and then a whole file.
function lognormalBytes(rand, median, sigma) {
  return Math.max(1, Math.min(MAX_PAYLOAD_BYTES, Math.round(median * Math.exp(sigma * gaussian(rand)))));
}

// Identifiers, keywords, punctuation and plain words: the vocabulary of what an
// agent reads and writes. Zipf-weighted, so a few tokens dominate the way
// `const` and `the` do, which is what gives real text its redundancy.
const VOCABULARY = (
  "const let return function if else for of in await async import export from type interface " +
  "string number boolean null undefined true false new this class extends throw try catch " +
  "( ) { } [ ] ; , . => = === !== + - * / < > && || ? : ` ' \" // " +
  "the a to of and is that it for on with as be this are or not by at from can if will " +
  "error result value data request response session event payload repo change commit " +
  "test expect describe it toBe toEqual length map filter reduce push slice join split " +
  "path file line status message body token owner name sha hash head base branch merge " +
  "db query select insert where order limit count sum id created_at updated_at kind seq " +
  "node npm git vitest fastify postgres docker make src test dist lib server bench"
).split(" ");

function zipfTable(size, exponent) {
  const cumulative = [];
  let total = 0;
  for (let rank = 1; rank <= size; rank++) {
    total += 1 / rank ** exponent;
    cumulative.push(total);
  }
  return cumulative.map((c) => c / total);
}

const ZIPF = zipfTable(VOCABULARY.length, 1.1);

function zipfToken(rand) {
  const r = rand();
  let lo = 0;
  let hi = ZIPF.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ZIPF[mid] < r) lo = mid + 1;
    else hi = mid;
  }
  return VOCABULARY[lo];
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function content(rand, profile, bytes) {
  if (profile === "random") {
    // Random "words" of 3-14 characters, not one unbroken base64 run. The first
    // version of this profile was base64, and #148's detector redacted nearly
    // all of it: its catch-all flags any run of 24+ token characters at 4.3+
    // bits/char (core/secret-scan.ts), which is exactly what base64 is — so the
    // incompressible bound was measuring the redaction marker. Breaking every
    // run well short of 24 keeps the entropy (six bits a character, which no
    // general-purpose codec does much with) and trips nothing.
    let s = "";
    while (s.length < bytes) {
      const word = 3 + Math.floor(rand() * 12);
      for (let i = 0; i < word; i++) s += B64[Math.floor(rand() * 64)];
      s += " ";
    }
    return s.slice(0, bytes);
  }
  const lines = [];
  let length = 0;
  while (length < bytes) {
    const words = 3 + Math.floor(rand() * 10);
    const indent = "  ".repeat(Math.floor(rand() * 4));
    const tokens = [];
    for (let i = 0; i < words; i++) tokens.push(zipfToken(rand));
    const line = indent + tokens.join(" ");
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join("\n").slice(0, bytes);
}

const hex = (rand, n) => {
  let s = "";
  for (let i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(rand() * 16)];
  return s;
};

const TOOLS = ["Read", "Bash", "Edit", "Grep", "Write"];

// One coding-agent turn's worth of event kinds, in roughly the proportions a
// harness emits them: mostly tool calls and model calls, some messages, a few
// test results and commits. The typed columns are filled the way the recorder
// fills them, because they are stored and indexed and therefore cost bytes too.
function generateEvent(rand, profile, gitSha) {
  const roll = rand();
  if (roll < 0.45) {
    const tool = TOOLS[Math.floor(rand() * TOOLS.length)];
    const input = tool === "Bash" ? { command: content(rand, profile, 20 + Math.floor(rand() * 60)) } : { file_path: `src/${hex(rand, 8)}.ts` };
    return {
      kind: "tool_call",
      type: tool,
      status: rand() < 0.9 ? "success" : "failure",
      duration_ms: Math.floor(rand() * 4000),
      payload: { tool_use_id: `toolu_${hex(rand, 24)}`, input, output: content(rand, profile, lognormalBytes(rand, 520, 1.25)) },
    };
  }
  if (roll < 0.75) {
    const tokensOut = 20 + Math.floor(rand() * 800);
    return {
      kind: "model_call",
      type: "assistant",
      model: "synthetic-model",
      tokens_in: 2_000 + Math.floor(rand() * 60_000),
      tokens_out: tokensOut,
      cost_micro_usd: Math.floor(rand() * 40_000),
      duration_ms: Math.floor(rand() * 20_000),
      payload: {
        message_id: `msg_${hex(rand, 24)}`,
        stop_reason: rand() < 0.8 ? "tool_use" : "end_turn",
        content: content(rand, profile, lognormalBytes(rand, 300, 0.8)),
      },
    };
  }
  if (roll < 0.95) {
    return { kind: "message", type: "user", payload: { role: "user", content: content(rand, profile, lognormalBytes(rand, 120, 0.7)) } };
  }
  if (roll < 0.98) {
    const failed = rand() < 0.2 ? 1 + Math.floor(rand() * 3) : 0;
    return {
      kind: "test_result",
      type: "vitest",
      status: failed ? "failure" : "success",
      duration_ms: Math.floor(rand() * 30_000),
      payload: { passed: 10 + Math.floor(rand() * 400), failed, output: content(rand, profile, lognormalBytes(rand, 600, 0.9)) },
    };
  }
  return { kind: "commit", type: "git", git_sha: gitSha, payload: { message: content(rand, profile, 40 + Math.floor(rand() * 120)) } };
}

// A harness's resumable state: a transcript pointer, the working set, and a
// running summary. Opaque to ADP and signed as a whole, so its size is the
// harness's choice — what the arm isolates is the envelope ADP adds around it.
function generateCheckpointState(rand, seq) {
  return {
    version: 1,
    seq,
    transcript_ref: `transcripts/${hex(rand, 32)}.jsonl`,
    open_files: Array.from({ length: 8 }, () => `src/${hex(rand, 8)}.ts`),
    todo: Array.from({ length: 5 }, () => content(rand, "text", 60)),
    summary: content(rand, "text", 1_500),
    context_tokens: 20_000 + Math.floor(rand() * 100_000),
  };
}

// A package-lock.json with a fixed dependency set. The same lockfile on every
// land is the case #194 is about: nothing about the dependencies changed, so
// nothing about the SBOM should have.
const PACKAGES = (
  "accepts array-flatten body-parser bytes call-bind content-disposition content-type cookie " +
  "cookie-signature debug depd destroy ee-first encodeurl escape-html etag express finalhandler " +
  "forwarded fresh function-bind get-intrinsic has has-symbols http-errors iconv-lite inherits " +
  "ipaddr.js media-typer merge-descriptors methods mime mime-db mime-types ms negotiator " +
  "object-inspect on-finished parseurl path-to-regexp proxy-addr qs range-parser raw-body " +
  "safe-buffer safer-buffer send serve-static setprototypeof side-channel statuses toidentifier " +
  "type-is unpipe utils-merge vary @esbuild/linux-x64 @types/node @vitest/expect @vitest/runner " +
  "@vitest/snapshot @vitest/spy @vitest/utils esbuild pathe picocolors postcss rollup tinypool " +
  "tinyspy vite vitest zod"
).split(" ");

function lockfile() {
  const packages = { "": { name: "bench-fixture", version: "1.0.0" } };
  PACKAGES.forEach((name, i) => {
    packages[`node_modules/${name}`] = {
      version: `${1 + (i % 5)}.${(i * 7) % 20}.${(i * 13) % 10}`,
      resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-1.0.0.tgz`,
      integrity: `sha512-${createHash("sha512").update(name).digest("base64")}`,
    };
  });
  return `${JSON.stringify({ name: "bench-fixture", version: "1.0.0", lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;
}

// --- measurement ------------------------------------------------------------

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

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const num = (v) => Number(v ?? 0);

async function snapshot(sql) {
  const rows = await sql(
    `select c.relname as name,
            pg_relation_size(c.oid, 'main') as heap,
            case when c.reltoastrelid = 0 then 0 else pg_total_relation_size(c.reltoastrelid) end as toast,
            pg_indexes_size(c.oid) as indexes,
            pg_total_relation_size(c.oid) as total
       from pg_class c
      where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace and c.relname = any($1)`,
    [TABLES],
  );
  const out = {};
  for (const r of rows) {
    const heap = num(r.heap);
    const toast = num(r.toast);
    const indexes = num(r.indexes);
    const total = num(r.total);
    // Free-space and visibility maps: allocated lazily by vacuum, so they are
    // reported rather than folded silently into one of the other three.
    out[r.name] = { heap, toast, indexes, other: total - heap - toast - indexes, total };
  }
  for (const table of TABLES) {
    const [{ count }] = await sql(`select count(*) as count from ${table}`);
    out[table] = { ...(out[table] ?? { heap: 0, toast: 0, indexes: 0, other: 0, total: 0 }), rows: num(count) };
  }
  return out;
}

function delta(before, after, table) {
  const a = after[table];
  const b = before[table];
  return {
    rows: a.rows - b.rows,
    heap: a.heap - b.heap,
    toast: a.toast - b.toast,
    indexes: a.indexes - b.indexes,
    other: a.other - b.other,
    total: a.total - b.total,
  };
}

// What batching would buy: the stored payloads, read back in chain order,
// compressed one at a time and then a batch at a time with the same algorithm.
// Same algorithm on both sides, so the difference is the batching and not the
// codec; TOAST's own figure (pglz or lz4, per the server's setting) is reported
// separately as what is realised today.
async function compressionOf(sql, sessionId, batchSizes) {
  let perEvent = 0;
  const batched = Object.fromEntries(batchSizes.map((b) => [b, { bytes: 0, pending: [] }]));
  let cursor = 0;
  for (;;) {
    const rows = await sql(
      "select seq, payload from session_events where session_id = $1 and seq > $2 order by seq limit 5000",
      [sessionId, cursor],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const text = JSON.stringify(row.payload);
      perEvent += deflateRawSync(text).length;
      for (const b of batchSizes) {
        const slot = batched[b];
        slot.pending.push(text);
        if (slot.pending.length === b) {
          slot.bytes += deflateRawSync(slot.pending.join("\n")).length;
          slot.pending = [];
        }
      }
    }
    cursor = rows[rows.length - 1].seq;
  }
  const result = { perEventDeflateBytes: perEvent, batchedDeflateBytes: {} };
  for (const b of batchSizes) {
    const slot = batched[b];
    if (slot.pending.length > 0) slot.bytes += deflateRawSync(slot.pending.join("\n")).length;
    result.batchedDeflateBytes[b] = slot.bytes;
  }
  return result;
}

// --- the driver -------------------------------------------------------------

class Api {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  // Every call names the statuses it accepts, and anything else throws. A
  // storage measurement taken over a run where some writes silently failed
  // measures the failure rate, not storage.
  async call(method, path, body, accept) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!accept.includes(res.status)) {
      throw new Error(`${method} ${path} returned ${res.status}, expected ${accept.join("/")}: ${text.slice(0, 600)}`);
    }
    return text ? JSON.parse(text) : null;
  }
}

/**
 * Run arm 4 against a server whose database only this arm is writing to.
 *
 * `sql(text, params)` must query that same database and resolve to rows. The
 * arm drives the server over HTTP exactly as a producer would, and measures
 * through `sql`, because what is being measured is what Postgres holds — a
 * number no HTTP route reports.
 *
 * `rss`, optional, measures the *server* process: `reset()` before a request,
 * `peak()` after it, resolving to `{ baselineBytes, peakBytes }`. `gitBytes(owner, repo)`, optional,
 * reports a repository's on-disk object bytes the way the storage meter does.
 */
export async function runStorageGrowth({
  baseUrl,
  token,
  owner,
  sql,
  rss = null,
  gitBytes = null,
  scale = DEFAULT_SCALE,
  seed = 1,
  now = () => performance.now(),
  log = () => {},
}) {
  const api = new Api(baseUrl, token);
  const rand = prng(seed);
  const startedAt = now();

  // Relation sizes are per table, not per tenant, so they only mean anything on
  // a database this arm has to itself. Refuse rather than publish a number
  // that silently includes somebody else's rows.
  const [{ count: preexisting }] = await sql("select count(*) as count from session_events");
  if (num(preexisting) !== 0) {
    throw new Error(
      `storage-growth needs a database only it writes to; session_events already holds ${preexisting} rows`,
    );
  }

  const [{ server_version: postgresVersion }] = await sql("show server_version");
  const [{ default_toast_compression: toastCompression }] = await sql("show default_toast_compression");
  const initial = await snapshot(sql);

  // -- fixtures: three repos, each seeded with one commit over git-data, so no
  // clone and no git binary on the driver's side (same as arm 1).
  async function seedRepo(name, files) {
    await api.call("POST", `/api/v3/repos/${owner}`, { name }, [201]);
    const tree = await api.call(
      "POST",
      `/api/v3/repos/${owner}/${name}/git/trees`,
      { tree: Object.entries(files).map(([path, text]) => ({ path, mode: "100644", type: "blob", content: text })) },
      [201],
    );
    const commit = await api.call(
      "POST",
      `/api/v3/repos/${owner}/${name}/git/commits`,
      { message: "seed", tree: tree.sha, parents: [] },
      [201],
    );
    await api.call("POST", `/api/v3/repos/${owner}/${name}/git/refs`, { ref: "refs/heads/main", sha: commit.sha }, [201]);
    const issue = await api.call(
      "POST",
      `/api/v3/repos/${owner}/${name}/issues`,
      { title: `storage-growth ${name}`, body: "arm 4 fixture" },
      [201],
    );
    return { name, sha: commit.sha, intentId: issue.intent_id };
  }

  const repos = {
    // No adp.yaml: the default, `trajectory.payloads: structure`.
    structure: await seedRepo("sg-structure", { "README.md": "arm 4\n" }),
    full: await seedRepo("sg-full", { "README.md": "arm 4\n", "adp.yaml": "trajectory:\n  payloads: full\n" }),
    lands: await seedRepo("sg-lands", { "README.md": "arm 4\n", "package-lock.json": lockfile() }),
  };

  async function startSession(repo, runId) {
    const session = await api.call(
      "POST",
      `/api/adp/repos/${owner}/${repo.name}/sessions`,
      { harness: "bench", ...(runId ? { run_id: runId } : {}) },
      [201],
    );
    return session.id;
  }

  const checkpointMs = [];

  // One producer appending `total` events, flushing at `batchSize` events or
  // the byte budget, whichever comes first. Returns the batches it sent with
  // their latency, and the payload bytes it supplied.
  async function produce({ repo, sessionId, producerId, total, profile, batchSize, onBatch, checkpointEvery }) {
    let supplied = 0;
    let produced = 0;
    let nextCheckpoint = checkpointEvery ?? Infinity;
    const occurredBase = Date.now();
    while (produced < total) {
      const events = [];
      let bytes = 0;
      while (produced + events.length < total && events.length < batchSize) {
        const event = generateEvent(rand, profile, repo.sha);
        const size = Buffer.byteLength(JSON.stringify(event.payload));
        if (events.length > 0 && bytes + size > BATCH_PAYLOAD_BUDGET_BYTES) break;
        const seq = produced + events.length + 1;
        events.push({
          ...event,
          client_event_id: `${producerId}:${seq}`,
          producer_seq: seq,
          occurred_at: new Date(occurredBase + seq).toISOString(),
        });
        bytes += size;
      }
      const t0 = now();
      const res = await api.call(
        "POST",
        `/api/adp/repos/${owner}/${repo.name}/sessions/${sessionId}/events`,
        { events, producer_id: producerId },
        [201],
      );
      const ms = now() - t0;
      if (res.appended !== events.length) {
        throw new Error(`appended ${res.appended} of ${events.length} events to ${sessionId}`);
      }
      produced += events.length;
      supplied += bytes;
      onBatch?.(events.length, ms);

      if (produced >= nextCheckpoint) {
        const t1 = now();
        await api.call(
          "POST",
          `/api/adp/repos/${owner}/${repo.name}/sessions/${sessionId}/checkpoints`,
          { git_sha: repo.sha, harness: "bench", state: generateCheckpointState(rand, produced) },
          [201],
        );
        checkpointMs.push(now() - t1);
        nextCheckpoint += checkpointEvery;
      }
    }
    return { supplied };
  }

  // -- 1. bytes per event, per payload mode and content profile ---------------
  const events = [];
  for (const cfg of BYTES_CONFIGS) {
    const repo = repos[cfg.mode];
    const sessionId = await startSession(repo);
    log(`bytes: ${cfg.mode}/${cfg.profile}, ${scale.bytesEvents} events`);
    const before = await snapshot(sql);
    const t0 = now();
    const { supplied } = await produce({
      repo,
      sessionId,
      producerId: `sg-${cfg.mode}-${cfg.profile}`,
      total: scale.bytesEvents,
      profile: cfg.profile,
      batchSize: scale.batchSize,
    });
    const wallClockMs = now() - t0;
    const after = await snapshot(sql);

    const [stored] = await sql(
      `select count(*) as events,
              count(payload_digest) as digested,
              count(redactions) as redacted,
              sum(pg_column_size(t.*)) as row_bytes,
              sum(pg_column_size(t.payload)) as payload_datum_bytes,
              sum(pg_column_size(t.payload::text::jsonb)) as payload_uncompressed_bytes,
              count(pg_column_compression(t.payload)) as compressed_rows
         from session_events t where session_id = $1`,
      [sessionId],
    );
    const [dedup] = await sql(
      `with p as (select md5(payload::text) as h, octet_length(payload::text) as n from session_events where session_id = $1)
       select (select sum(n) from p) as total, (select sum(n) from (select distinct on (h) n from p) d) as distinct_bytes`,
      [sessionId],
    );

    events.push({
      ...cfg,
      events: num(stored.events),
      wallClockMs,
      suppliedPayloadBytes: supplied,
      stored: {
        // Structure mode records a digest beside every payload it projected;
        // full mode records none. The arm checks which one it actually got, so
        // a misapplied adp.yaml is a failed run rather than a mislabelled one.
        digestedEvents: num(stored.digested),
        // #148's detector rewrites what it recognises before anything is stored,
        // so a corpus that trips it measures the detector. Counted, and the
        // e2e test requires zero.
        redactedEvents: num(stored.redacted),
        rowBytes: num(stored.row_bytes),
        payloadDatumBytes: num(stored.payload_datum_bytes),
        payloadUncompressedBytes: num(stored.payload_uncompressed_bytes),
        compressedRows: num(stored.compressed_rows),
      },
      relation: delta(before, after, "session_events"),
      compression: await compressionOf(sql, sessionId, [scale.batchSize, 1000]),
      dedup: { payloadTextBytes: num(dedup.total), distinctPayloadTextBytes: num(dedup.distinct_bytes) },
    });
  }

  // -- 2. the ingest curve, with concurrent writers into one run ---------------
  log(`ingest: ${scale.ingestEvents} events over ${scale.writers} writers`);
  const run = await api.call(
    "POST",
    `/api/adp/repos/${owner}/${repos.structure.name}/runs`,
    { intent_id: repos.structure.intentId, orchestrator: "bench" },
    [201],
  );
  const sessionIds = [];
  for (let w = 0; w < scale.writers; w++) sessionIds.push(await startSession(repos.structure, run.id));

  const ingestBefore = await snapshot(sql);
  const ingestStart = now();
  const batches = [];
  const perWriter = Math.floor(scale.ingestEvents / scale.writers);
  await Promise.all(
    sessionIds.map((sessionId, w) =>
      produce({
        repo: repos.structure,
        sessionId,
        producerId: `sg-ingest-w${w}`,
        total: perWriter,
        profile: "text",
        batchSize: scale.batchSize,
        checkpointEvery: scale.checkpointEvery,
        // [writer, completed-at ms since ingest start, events, latency ms]
        onBatch: (n, ms) => batches.push([w, round(now() - ingestStart), n, round(ms)]),
      }),
    ),
  );
  const ingestWallClockMs = now() - ingestStart;
  const ingestAfter = await snapshot(sql);

  const [cp] = await sql(
    `select count(*) as count,
            sum(pg_column_size(t.*)) as row_bytes,
            sum(pg_column_size(t.state)) as state_bytes,
            sum(pg_column_size(t.envelope)) as envelope_bytes
       from checkpoints t where session_id = any($1)`,
    [sessionIds],
  );
  const [ingestRows] = await sql(
    "select count(*) as events, sum(pg_column_size(t.*)) as row_bytes from session_events t where session_id = any($1)",
    [sessionIds],
  );

  // -- 3. peak server RSS on /verify -----------------------------------------
  async function measureVerify(target, path) {
    await rss?.reset();
    const t0 = now();
    const body = await api.call("GET", path, undefined, [200]);
    const ms = now() - t0;
    if (body.ok !== true) throw new Error(`${path} did not verify: ${JSON.stringify(body).slice(0, 600)}`);
    // The baseline is kept, not just the growth. A server that has just
    // ingested a quarter of a million events has a warm heap, and a verify
    // that fits inside it grows nothing — which is what a bounded read looks
    // like, and also something a reader has to be able to see was the case.
    const memory = rss ? await rss.peak() : null;
    return {
      target,
      ms,
      baselineRssBytes: memory ? memory.baselineBytes : null,
      peakRssBytes: memory ? memory.peakBytes : null,
      peakRssOverBaselineBytes: memory ? memory.peakBytes - memory.baselineBytes : null,
    };
  }
  log("verify");
  const runPath = `/api/adp/repos/${owner}/${repos.structure.name}/runs/${run.id}/verify`;
  const verify = [
    { ...(await measureVerify("run", runPath)), coverage: "full", sessions: scale.writers, events: perWriter * scale.writers },
    {
      ...(await measureVerify("run", `${runPath}?from=checkpoint`)),
      coverage: "from-checkpoint",
      sessions: scale.writers,
      events: perWriter * scale.writers,
    },
    {
      ...(await measureVerify("session", `/api/adp/repos/${owner}/${repos.structure.name}/sessions/${sessionIds[0]}/verify`)),
      coverage: "full",
      sessions: 1,
      events: perWriter,
    },
  ];

  // -- 4. landed changes, and what each one leaves behind ----------------------
  log(`lands: ${scale.lands}`);
  const landRepo = repos.lands;
  const gitBefore = gitBytes ? await gitBytes(owner, landRepo.name) : null;
  const landsBefore = await snapshot(sql);
  const landMs = [];
  for (let i = 0; i < scale.lands; i++) {
    const t0 = now();
    const base = await api.call("GET", `/api/v3/repos/${owner}/${landRepo.name}/git/refs/heads/main`, undefined, [200]);
    // A prefix match returning an array, GitHub's own shape — pick the exact
    // ref rather than trusting position, as arm 1 does.
    const baseSha = base.find((r) => r.ref === "refs/heads/main").object.sha;
    const tree = await api.call(
      "POST",
      `/api/v3/repos/${owner}/${landRepo.name}/git/trees`,
      {
        base_tree: baseSha,
        tree: [{ path: `change-${i}.ts`, mode: "100644", type: "blob", content: content(rand, "text", 1_200) }],
      },
      [201],
    );
    const commit = await api.call(
      "POST",
      `/api/v3/repos/${owner}/${landRepo.name}/git/commits`,
      { message: `change ${i}`, tree: tree.sha, parents: [baseSha] },
      [201],
    );
    const branch = `sg/change-${i}`;
    await api.call("POST", `/api/v3/repos/${owner}/${landRepo.name}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha }, [201]);
    // The signed change record an agent's provenance binds, as `adp` writes it.
    await api.call(
      "POST",
      `/api/v3/repos/${owner}/${landRepo.name}/changes`,
      { git_sha: commit.sha, intent_id: landRepo.intentId },
      [200, 201],
    );
    const proposal = await api.call(
      "POST",
      `/api/v3/repos/${owner}/${landRepo.name}/pulls`,
      { title: `change ${i}`, head: branch, base: "main" },
      [201],
    );
    await api.call("PUT", `/api/v3/repos/${owner}/${landRepo.name}/pulls/${proposal.number}/merge`, { merge_method: "merge" }, [200]);
    landMs.push(round(now() - t0));
  }
  const landsAfter = await snapshot(sql);
  const gitAfter = gitBytes ? await gitBytes(owner, landRepo.name) : null;

  const [landRepoRow] = await sql("select id from repos where owner = $1 and name = $2", [owner, landRepo.name]);
  const landRows = {};
  for (const table of ["changes", "proposals", "gate_results", "operations"]) {
    const [r] = await sql(`select count(*) as count, sum(pg_column_size(t.*)) as row_bytes from ${table} t where repo_id = $1`, [
      landRepoRow.id,
    ]);
    landRows[table] = { rows: num(r.count), rowBytes: num(r.row_bytes) };
  }

  // #194, measured: how much of the SBOM bytes every land records are copies,
  // at three grains, distinct-by-content over each. The whole statement is
  // what is stored. The SBOM with #194's two clock-and-UUID fields taken out
  // is what a deterministic SBOM would store — and it still names the commit
  // it describes (`metadata.component.version`), so across lands it is still
  // one document per sha. The component list alone is the part that is a pure
  // function of the lockfile, and the only grain at which an unchanged
  // dependency set is actually a copy.
  const sbomRows = await sql(
    "select envelope, pg_column_size(envelope) as datum from gate_results where repo_id = $1 and name = 'sbom'",
    [landRepoRow.id],
  );
  const grains = { statement: new Map(), withoutSerialAndTimestamp: new Map(), components: new Map() };
  let envelopeDatumBytes = 0;
  for (const row of sbomRows) {
    envelopeDatumBytes += num(row.datum);
    const statementText = Buffer.from(row.envelope.payload, "base64").toString("utf8");
    const statement = JSON.parse(statementText);
    const sbom = statement.predicate;
    const { serialNumber: _serial, metadata, ...rest } = sbom;
    const { timestamp: _timestamp, ...metadataRest } = metadata ?? {};
    const bodyText = canonical({ ...rest, metadata: metadataRest });
    const componentsText = canonical(sbom.components ?? []);
    for (const [grain, text] of [
      ["statement", statementText],
      ["withoutSerialAndTimestamp", bodyText],
      ["components", componentsText],
    ]) {
      const key = sha256(text);
      const entry = grains[grain].get(key) ?? { bytes: Buffer.byteLength(text), copies: 0 };
      entry.copies++;
      grains[grain].set(key, entry);
    }
  }
  const dedupOf = (map) => {
    let total = 0;
    let distinct = 0;
    for (const e of map.values()) {
      total += e.bytes * e.copies;
      distinct += e.bytes;
    }
    return { documents: [...map.values()].reduce((a, e) => a + e.copies, 0), distinctDocuments: map.size, bytes: total, distinctBytes: distinct };
  };

  // -- 5. operations, and the meter against the relations --------------------
  const final = await snapshot(sql);
  const opsByVerb = await sql(
    "select verb, count(*) as count, sum(pg_column_size(t.*)) as row_bytes from operations t group by verb order by verb",
  );
  const meter = {};
  for (const table of TABLES) {
    const [r] = await sql(`select coalesce(sum(pg_column_size(t.*)), 0) as row_bytes from ${table} t`);
    meter[table] = { rows: final[table].rows, rowBytes: num(r.row_bytes), relationBytes: final[table].total };
  }

  return {
    arm: "storage-growth",
    config: {
      ...scale,
      seed,
      batchPayloadBudgetBytes: BATCH_PAYLOAD_BUDGET_BYTES,
      maxPayloadBytes: MAX_PAYLOAD_BYTES,
      observedMeanPayloadBytes: OBSERVED_MEAN_PAYLOAD_BYTES,
    },
    postgres: { version: postgresVersion, toastCompression },
    wallClockMs: now() - startedAt,
    events,
    ingest: {
      writers: scale.writers,
      batchSize: scale.batchSize,
      events: num(ingestRows.events),
      rowBytes: num(ingestRows.row_bytes),
      wallClockMs: ingestWallClockMs,
      relation: delta(ingestBefore, ingestAfter, "session_events"),
      batches,
    },
    checkpoints: {
      count: num(cp.count),
      rowBytes: num(cp.row_bytes),
      stateDatumBytes: num(cp.state_bytes),
      envelopeDatumBytes: num(cp.envelope_bytes),
      relation: delta(ingestBefore, ingestAfter, "checkpoints"),
      latencyMs: checkpointMs.map(round),
    },
    verify,
    lands: {
      count: scale.lands,
      latencyMs: landMs,
      gitBytes: gitBytes ? { before: gitBefore, after: gitAfter } : null,
      relation: Object.fromEntries(
        ["changes", "proposals", "gate_results", "operations"].map((t) => [t, delta(landsBefore, landsAfter, t)]),
      ),
      rows: landRows,
      sbom: {
        envelopeDatumBytes,
        statement: dedupOf(grains.statement),
        withoutSerialAndTimestamp: dedupOf(grains.withoutSerialAndTimestamp),
        components: dedupOf(grains.components),
      },
    },
    operations: {
      byVerb: opsByVerb.map((r) => ({ verb: r.verb, rows: num(r.count), rowBytes: num(r.row_bytes) })),
      relation: delta(initial, final, "operations"),
    },
    meter,
  };
}

function round(ms) {
  return Math.round(ms * 10) / 10;
}
