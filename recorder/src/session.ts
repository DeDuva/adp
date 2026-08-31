// What a spool needs to know about itself once the process that made it is gone.
//
// `adp-recorder flush` exists to finish a session a dead recorder started, and
// it can only do that if the spool says where the events were going. Hence a
// sidecar beside every spool: the repository, the harness, and — once ADP has
// given us one — the session id.
//
// **The spool is keyed by a local id, not by the server's session id, and that
// is the point.** #149 requires that ADP being unreachable must not lose a
// session; if the spool could only be opened after `POST /sessions` succeeded,
// then a recorder started while the server was down would have nowhere to put
// the first minute of the session, which is exactly the case the requirement
// names. So recording begins immediately against a locally-generated handle,
// and the server's id is written here when it arrives.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface SessionMeta {
  /** This recorder's own handle for the session; also the spool's filename stem. */
  localId: string;
  owner: string;
  repo: string;
  harness: string;
  /** Null until `POST /sessions` has succeeded — see the note above. */
  sessionId: string | null;
  intentId?: string;
  runId?: string;
  /** The harness's own session id, once its stream has told us one. */
  harnessSessionId?: string;
  startedAt: string;
  /** Set by `close`, so `flush` can tell an abandoned spool from a finished one. */
  endedAt?: string;

  // ── The lifecycle (#151) ────────────────────────────────────────────────
  //
  // **`outcome` starts as `suspended` and is only ever upgraded**, which is the
  // whole trick that makes an interrupted session say so. A recorder killed
  // outright runs no shutdown code — there is nothing to write at the moment it
  // dies — so the fact has to already be on disk before it is true, and the
  // clean exit is the thing that has to announce itself. The inverse, writing
  // `closed` at the end, means every hard kill leaves a session that claims to
  // have finished.
  /** How this session ended, or will be recorded as having ended. */
  outcome?: "closed" | "suspended";
  /** Whether ADP has been told. Separate from `outcome`, because being unable to say it does not change it. */
  terminated?: boolean;
  /** The session this one resumes, when the harness was resuming. */
  resumedFromSessionId?: string;
  /** The recorder that owns this spool, so `flush` does not end a session someone is still writing. */
  pid?: number;
  host?: string;
}

export function metaPath(dir: string, localId: string): string {
  return path.join(dir, `${path.basename(localId)}.meta.json`);
}

export function newSessionMeta(input: {
  dir: string;
  owner: string;
  repo: string;
  harness: string;
  intentId?: string;
  runId?: string;
}): SessionMeta {
  const meta: SessionMeta = {
    localId: randomUUID(),
    owner: input.owner,
    repo: input.repo,
    harness: input.harness,
    sessionId: null,
    intentId: input.intentId,
    runId: input.runId,
    startedAt: new Date().toISOString(),
    // Suspended until something says otherwise — see the note on the field.
    outcome: "suspended",
    terminated: false,
    pid: process.pid,
    host: hostname(),
  };
  writeSessionMeta(input.dir, meta);
  return meta;
}

/**
 * Is the recorder that opened this spool still running?
 *
 * `flush` ends sessions, and ending one someone is still appending to would
 * turn their live recording into a stream of 409s. Signal 0 asks the kernel
 * whether a pid exists without sending anything, which is the cheapest honest
 * answer available — and it is only asked on the machine that wrote the spool,
 * because a pid from another host means nothing here.
 *
 * Pid reuse can make this say "alive" about an unrelated process. The cost of
 * that is a session left active until the next flush rather than a session
 * ended under a live writer, which is the right way round.
 */
export function producerAlive(meta: SessionMeta): boolean {
  if (meta.host !== hostname() || typeof meta.pid !== "number") return false;
  if (meta.pid === process.pid) return false;
  try {
    process.kill(meta.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Written by rename, like the acknowledgement mark: a process dying mid-update
 * leaves the previous sidecar rather than a truncated one, and a truncated
 * sidecar is a spool nobody can ever deliver.
 */
export function writeSessionMeta(dir: string, meta: SessionMeta): void {
  mkdirSync(dir, { recursive: true });
  const target = metaPath(dir, meta.localId);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`);
  renameSync(tmp, target);
}

export function readSessionMeta(dir: string, localId: string): SessionMeta | null {
  const file = metaPath(dir, localId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SessionMeta;
  } catch {
    return null;
  }
}

/**
 * Every session this spool directory knows about.
 *
 * What `flush` walks. A sidecar with no events file is not an error — it is a
 * session that started and produced nothing yet — so it is listed and left
 * alone rather than treated as corruption.
 */
export function listSessions(dir: string): SessionMeta[] {
  if (!existsSync(dir)) return [];
  const out: SessionMeta[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".meta.json")) continue;
    const meta = readSessionMeta(dir, entry.slice(0, -".meta.json".length));
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
