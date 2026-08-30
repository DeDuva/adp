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
  };
  writeSessionMeta(input.dir, meta);
  return meta;
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
