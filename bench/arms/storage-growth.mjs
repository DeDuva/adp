#!/usr/bin/env node
// CLI rig for arm 4. The measurement is bench/lib/storage-growth.mjs, which the
// server's e2e suite also drives at small N — one implementation, so the number
// CI enforces and the number published here come from the same code.
//
//   DATABASE_URL=postgres://... node arms/storage-growth.mjs \
//     [--scale default|ci] [--seed 1] [--ingestEvents 500000] [--out runs/<name>.json]
//
// `make bench-storage` builds the server and runs this against `make up`'s
// Postgres, which is the intended way in.
//
// Unlike arm 1's, this rig brings its own server rather than pointing at one,
// because two of the things it measures depend on that. Relation sizes are per
// table, not per tenant, so they only describe this arm on a database nobody
// else writes to — the rig creates one and drops it afterwards. And peak RSS
// on /verify has to be the *server's*, so the server runs as a process of its
// own — the built `server/dist/main.js`, the artifact that ships — rather than
// as code loaded into this one, where the driver's own allocations would be
// counted with it.

import { spawn, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runStorageGrowth, dropArmDatabase, DEFAULT_SCALE, CI_SCALE } from "../lib/storage-growth.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const serverDir = path.join(repoRoot, "server");
const serverMain = path.join(serverDir, "dist", "main.js");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const log = (message) => console.error(`[storage-growth ${new Date().toISOString().slice(11, 19)}] ${message}`);

// Below the kernel's ephemeral floor, for the reason scripts/dev/ports.sh
// gives: a port inside that range can lose `listen()` to an unrelated outbound
// socket, and the server then dies at startup with nothing pointing at why.
async function pickPort() {
  let floor = 49152;
  try {
    floor = Number((await readFile("/proc/sys/net/ipv4/ip_local_port_range", "utf8")).trim().split(/\s+/)[0]);
  } catch {
    // Not Linux: the IANA floor.
  }
  let low = 20000;
  let high = floor - 1;
  if (high <= low + 1024) {
    low = high + 1;
    high = low + 8192;
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = low + Math.floor(Math.random() * (high - low));
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "0.0.0.0", () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`no free port found in ${low}-${high}`);
}

// The server's own RSS, from /proc, two ways at once, taking the larger.
//
// Writing 5 to clear_refs resets the high-water mark, so VmHWM afterwards
// should be the peak of exactly the request in between. It is not quite: the
// kernel folds current RSS into the mark lazily, and on per-CPU counters (6.2
// onwards) both figures are approximate by up to a batch per CPU — the first
// CI-scale run read a peak 0.7 MB *below* its own baseline. So VmRSS is also
// sampled every 5 ms while the request runs. Each method covers the other's
// gap: sampling misses a spike between reads, the mark misses one it was
// never told about. At CI scale the result is inside that noise. At the
// published scale, on a server still warm from ingest, a whole-run verify moved
// it by nothing measurable — which is why the baseline is recorded beside the
// growth, and the report says what that does and does not show.
//
// Null off Linux, and the record says so rather than inventing a number.
function procRss(pid) {
  if (!existsSync(`/proc/${pid}/status`)) return null;
  const read = async () => {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const kib = (key) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(status)?.[1] ?? NaN) * 1024;
    return { rss: kib("VmRSS"), hwm: kib("VmHWM") };
  };
  let baseline = 0;
  let sampled = 0;
  let timer = null;
  return {
    async reset() {
      await writeFile(`/proc/${pid}/clear_refs`, "5");
      baseline = (await read()).rss;
      sampled = baseline;
      timer = setInterval(() => {
        read().then(({ rss }) => (sampled = Math.max(sampled, rss)), () => {});
      }, 5);
    },
    async peak() {
      clearInterval(timer);
      const { rss, hwm } = await read();
      return { baselineBytes: baseline, peakBytes: Math.max(sampled, hwm, rss) };
    },
  };
}

function waitForLine(child, pattern, timeoutMs, tail) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server not ready after ${timeoutMs} ms:\n${tail.join("\n")}`)), timeoutMs);
    const onLine = (line) => {
      if (pattern.test(line)) {
        clearTimeout(timer);
        child.off("line", onLine);
        resolve();
      }
    };
    child.on("line", onLine);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code} before it was ready:\n${tail.join("\n")}`));
    });
  });
}

async function runNode(script, args, env) {
  const { stdout } = await execFileAsync(process.execPath, [script, ...args], { cwd: serverDir, env });
  return stdout;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.error("Usage: DATABASE_URL=postgres://... node arms/storage-growth.mjs [--scale default|ci] [--seed N] [--out FILE]");
    console.error("       (`make bench-storage` supplies DATABASE_URL from `make up`)");
    process.exit(2);
  }
  if (!existsSync(serverMain)) {
    console.error(`storage-growth: ${path.relative(repoRoot, serverMain)} is missing — run \`npm run build --prefix server\` (make bench-storage does)`);
    process.exit(2);
  }

  const scale = { ...(args.scale === "ci" ? CI_SCALE : DEFAULT_SCALE) };
  for (const key of Object.keys(scale)) if (args[key] !== undefined) scale[key] = Number(args[key]);
  const seed = Number(args.seed ?? 1);

  // The rig needs a Postgres client and bench/ has no runtime dependencies. The
  // server it is about to boot already has one, so borrow that rather than add
  // a second to keep in step with it.
  const pg = createRequire(path.join(serverDir, "package.json"))("pg");
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const dbName = `bench_storage_growth_${Date.now()}`;
  const target = new URL(adminUrl);
  target.pathname = `/${dbName}`;
  const gitRoot = await mkdtemp(path.join(os.tmpdir(), "adp-bench-storage-git-"));
  const port = await pickPort();
  const owner = "bench";

  const env = {
    ...process.env,
    DATABASE_URL: target.toString(),
    GIT_ROOT: gitRoot,
    SIGNING_KEY: `bench-${randomBytes(16).toString("hex")}`,
    MIRROR_CREDENTIAL_KEY: `bench-${randomBytes(16).toString("hex")}`,
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    PORT: String(port),
    // What a land stores, not what it takes to be allowed one: the default
    // floor refuses a land with no gate result, and this arm reports none.
    LAND_POLICY_FLOOR: "",
  };

  let child = null;
  let pool = null;
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
    log(`database ${dbName}`);
    await runNode(path.join("dist", "db", "migrate.js"), [], env);
    const minted = await runNode(path.join("dist", "bootstrap.js"), ["storage-growth-bench", "--org", owner], env);
    const token = /^Token:\s+(\S+)/m.exec(minted)?.[1];
    if (!token) throw new Error(`bootstrap printed no token:\n${minted}`);

    child = spawn(process.execPath, [serverMain], { cwd: serverDir, env, stdio: ["ignore", "pipe", "pipe"] });
    // Fastify logs every request. Drained continuously — a pipe nobody reads
    // fills, and then the server blocks on its own logger mid-measurement —
    // with the last lines kept for a diagnosis if it dies.
    const tail = [];
    for (const stream of [child.stdout, child.stderr]) {
      let buffered = "";
      stream.on("data", (chunk) => {
        buffered += chunk;
        let nl;
        while ((nl = buffered.indexOf("\n")) !== -1) {
          const line = buffered.slice(0, nl);
          buffered = buffered.slice(nl + 1);
          tail.push(line);
          if (tail.length > 40) tail.shift();
          child.emit("line", line);
        }
      });
    }
    // Its own readiness line, not a port probe, which a squatter would satisfy.
    await waitForLine(child, new RegExp(`Server listening at .*:${port}`), 30_000, tail);
    log(`server pid ${child.pid} on :${port}`);

    pool = new pg.Pool({ connectionString: target.toString(), max: 2 });
    const rss = procRss(child.pid);
    const result = await runStorageGrowth({
      baseUrl: `http://127.0.0.1:${port}`,
      token,
      owner,
      sql: async (text, params) => (await pool.query(text, params)).rows,
      rss,
      // The storage meter's own measure (GitBackend.diskUsageBytes), so the
      // git term here is the one a quota is enforced against.
      gitBytes: async (o, r) => {
        const { stdout } = await execFileAsync("git", ["count-objects", "-v"], { cwd: path.join(gitRoot, o, `${r}.git`) });
        let kib = 0;
        for (const line of stdout.split("\n")) {
          const [key, value] = line.split(":");
          if (key === "size" || key === "size-pack") kib += Number(value?.trim() ?? 0) || 0;
        }
        return kib * 1024;
      },
      scale,
      seed,
      log,
    });

    let serverCommit = process.env.ADP_SERVER_COMMIT ?? null;
    if (!serverCommit) {
      try {
        serverCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim();
      } catch {
        // Not a checkout; recorded as unknown.
      }
    }

    // The reproducibility contract (bench/README.md): a run record carries
    // enough context to re-derive and re-run it.
    const record = {
      recordedAt: new Date().toISOString(),
      arm: "storage-growth",
      deterministic: true,
      environment: {
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        cpu: os.cpus()[0]?.model ?? null,
        cpus: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        serverCommit,
        server: "server/dist/main.js, its own process",
        rss: rss ? "/proc/<pid> VmHWM after clear_refs=5" : null,
      },
      result,
    };

    const output = JSON.stringify(record, null, 2);
    if (args.out) {
      const out = path.resolve(String(args.out));
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, `${output}\n`);
      log(`wrote ${path.relative(process.cwd(), out)}`);
    } else {
      console.log(output);
    }
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(killer);
    }
    await pool?.end();
    await dropArmDatabase(async (text, params) => (await admin.query(text, params)).rows, dbName).catch((err) =>
      log(`could not drop ${dbName}: ${err.message}`),
    );
    await admin.end();
    await rm(gitRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
