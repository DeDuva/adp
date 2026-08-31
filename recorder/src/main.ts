// `adp-recorder` — three verbs, and no fourth.
//
//   tail   follow a transcript the harness is writing, and record it
//   wrap   run the harness, tee its stream, and record that
//   flush  finish spools a previous recorder left behind
//
// `flush` is the one that looks optional and is not. A recorder that dies with
// its terminal leaves events on disk that nobody will ever deliver, and
// undelivered events are indistinguishable from events that never happened —
// which is the gap #149 is about. `flush` is how the next run cleans up after
// the last one, and it is what makes "survives its shell" true rather than
// aspirational.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { TrajectoryClient } from "./client.js";
import { loadConfig } from "./config.js";
import { builtinHarnesses, DEFAULT_HARNESS, resolveReader } from "./readers/index.js";
import { Recorder } from "./recorder.js";
import { Spool } from "./spool.js";
import { Shipper } from "./shipper.js";
import { listSessions, newSessionMeta, producerAlive, writeSessionMeta, type SessionMeta } from "./session.js";
import { Lifecycle, DEFAULT_IDLE_MS, type Outcome } from "./lifecycle.js";
import { headIntentTrailer, headSha } from "./git.js";
import { tailFile } from "./tail.js";

function usage(): never {
  console.error(`usage: adp-recorder <command>

  tail  --repo <owner/name> --file <transcript.jsonl> [--from-start]
        [--harness <name>] [--reader <module>] [--intent <uuid|#n>] [--run <uuid>]
        [--dir <path>] [--idle-ms <n>] [--continue] [--resume-from <session-id>]

  wrap  --repo <owner/name> [--harness <name>] [--reader <module>]
        [--intent <uuid|#n>] [--run <uuid>] [--dir <path>] [--idle-ms <n>]
        [--continue] [--resume-from <session-id>] -- <command> [args...]

  flush [--repo <owner/name>]

Harnesses with a reader built in: ${builtinHarnesses().join(", ")} (default ${DEFAULT_HARNESS}).
--reader loads your own; it exports createReader() returning { read, end }.

The session lifecycle needs nothing typed. --dir is the checkout being worked in
(default: the working directory); the intent comes from HEAD's ADP-Intent trailer
when --intent is absent; checkpoints happen at boundaries; a clean exit closes the
session and anything else suspends it. --continue picks up where this machine's
last suspended session in the repository left off, across harnesses.

Environment: ADP_SERVER_URL, ADP_TOKEN, and optionally ADP_RECORDER_SPOOL.`);
  process.exit(2);
}

interface Args {
  command: string;
  flags: Record<string, string | true>;
  rest: string[];
}

function parseArgs(argv: string[]): Args {
  const [command, ...tail] = argv;
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < tail.length; i += 1) {
    const arg = tail[i]!;
    if (arg === "--") {
      rest.push(...tail.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = tail[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return { command: command ?? "", flags, rest };
}

function splitRepo(value: unknown): { owner: string; repo: string } {
  if (typeof value !== "string" || !value.includes("/")) {
    console.error("--repo must be <owner>/<name>");
    process.exit(2);
  }
  const [owner, repo] = value.split("/", 2);
  return { owner: owner!, repo: repo! };
}

/** One line of status, so a recorder that is stuck says so rather than looking busy. */
function announce(report: {
  state: string;
  delivered: number;
  pending: number;
  reason?: string;
  notes?: string[];
}): void {
  const detail = report.reason ? ` — ${report.reason}` : "";
  console.error(`adp-recorder: ${report.state} (delivered ${report.delivered}, pending ${report.pending})${detail}`);
  for (const note of report.notes ?? []) console.error(`adp-recorder: ${note}`);
}

/**
 * Which session, if any, this one continues.
 *
 * Two ways, and neither asks the user to know a UUID:
 *
 * **The harness is resuming.** `claude --resume <id>` and `codex resume <id>`
 * both re-emit the id they were given, so a stream whose harness session id
 * this spool has recorded before *is* a resume — and ADP learns the lineage
 * without anybody calling `resume` by hand, which is the whole point of #151.
 * The previous spool must be finished (`endedAt`), or this is a second
 * recorder attached to a session someone is still writing.
 *
 * **`--continue`.** The cross-harness case, which no stream can signal because
 * the other harness has never heard of this one's ids. It picks the last
 * session this spool suspended in this repository, whichever harness recorded
 * it. That is one flag, and what it saves is the part that would otherwise be
 * assembled by hand: finding the session, choosing its checkpoint, and linking
 * the lineage.
 */
function findResumeTarget(
  sessions: SessionMeta[],
  self: { owner: string; repo: string; harness: string; localId: string },
  input: { harnessSessionId?: string; continueLast?: boolean },
): SessionMeta | null {
  const here = sessions.filter(
    (m) => m.owner === self.owner && m.repo === self.repo && m.localId !== self.localId && m.sessionId !== null,
  );
  if (input.harnessSessionId) {
    const sameHarnessSession = here.filter(
      (m) => m.harness === self.harness && m.harnessSessionId === input.harnessSessionId && m.endedAt,
    );
    const latest = sameHarnessSession[sameHarnessSession.length - 1];
    if (latest) return latest;
  }
  if (input.continueLast) {
    const suspended = here.filter((m) => m.endedAt && m.outcome === "suspended");
    return suspended[suspended.length - 1] ?? null;
  }
  return null;
}

async function runSession(
  args: Args,
  lines: (onLine: (line: string) => void, stopped: Promise<void>) => Promise<Outcome>,
): Promise<void> {
  const config = loadConfig();
  const { owner, repo } = splitRepo(args.flags.repo);
  const harness = typeof args.flags.harness === "string" ? args.flags.harness : DEFAULT_HARNESS;
  const dir = typeof args.flags.dir === "string" ? args.flags.dir : process.cwd();

  // Resolved before the session exists, and fatal when it cannot be. A reader
  // chosen *after* `POST /sessions` would leave an empty session behind on
  // every typo, and an unknown harness is refused rather than defaulted — see
  // `resolveReader`, where the reason is that recording a codex stream through
  // the claude-code parser succeeds, looks like a recording, and is worthless.
  let reader;
  try {
    reader = await resolveReader({
      harness,
      module: typeof args.flags.reader === "string" ? args.flags.reader : undefined,
    });
  } catch (err) {
    console.error(`adp-recorder: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const client = new TrajectoryClient(config.ADP_SERVER_URL, config.ADP_TOKEN);

  // **The intent is derivable, so nobody should be typing it.** The commit
  // trailer #142 established already names it, and a session that starts
  // against a checkout whose HEAD says which intent the work answers should
  // not also require the UUID on a command line. `--intent` still wins where
  // one is given, and both forms the trailer allows — a UUID or an issue
  // reference — are accepted here, because making the user learn which of the
  // two the session route takes is the same defect one layer down.
  const intentFlag = typeof args.flags.intent === "string" ? args.flags.intent : headIntentTrailer(dir);
  const intentId = intentFlag ? ((await client.resolveIntent(owner, repo, intentFlag)) ?? undefined) : undefined;
  if (intentFlag && !intentId) {
    console.error(`adp-recorder: could not resolve intent '${intentFlag}' — recording without one`);
  }

  const meta = newSessionMeta({
    dir: config.ADP_RECORDER_SPOOL,
    owner,
    repo,
    harness,
    intentId,
    runId: typeof args.flags.run === "string" ? args.flags.run : undefined,
  });

  // Every spool this directory already holds, read once and before this
  // session's own sidecar can appear in the list a second time.
  const previous = listSessions(config.ADP_RECORDER_SPOOL);
  const explicitResume = typeof args.flags["resume-from"] === "string" ? args.flags["resume-from"] : undefined;
  const resumeTarget =
    explicitResume ??
    findResumeTarget(previous, { owner, repo, harness, localId: meta.localId }, {
      continueLast: args.flags.continue === true,
    })?.sessionId ??
    undefined;

  const lifecycle = new Lifecycle({
    dir,
    idleMs: typeof args.flags["idle-ms"] === "string" ? Number(args.flags["idle-ms"]) : DEFAULT_IDLE_MS,
  });
  // The commit the session starts at is not a boundary — the harness has not
  // done anything yet. Seeding it is what makes the *next* commit one.
  lifecycle.startedAt(headSha(dir));

  const recorder = new Recorder(
    {
      client,
      spoolDir: config.ADP_RECORDER_SPOOL,
      meta,
      producerId: config.ADP_RECORDER_ID,
      batchSize: config.ADP_RECORDER_BATCH_SIZE,
      maxSpoolBytes: config.ADP_RECORDER_MAX_SPOOL_BYTES,
      lifecycle,
      resumeFromSessionId: resumeTarget,
    },
    reader,
  );

  // Delivery on a timer, not per event. Batching is what keeps this cheap, and
  // the interval is the only thing that decides how far behind ADP can be.
  const timer = setInterval(() => {
    void recorder.flush().catch(() => undefined);
  }, config.ADP_RECORDER_FLUSH_INTERVAL_MS);
  timer.unref?.();

  // A signal is the ordinary way a session ends — the terminal closes, or
  // someone presses ^C — so it has to be the path that *drains*, and there has
  // to be exactly one of those.
  //
  // The first version had the handler call the drain directly and then
  // `process.exit(0)`. That raced the stream loop it was supposed to be
  // ending: the exit could win, taking the undelivered tail of the session
  // with it, and the trailing lines the loop read on its way out arrived after
  // the session had been closed. The e2e that follows a live transcript caught
  // it by recording nothing at all.
  //
  // So a signal only *asks* to stop. The stream loop notices, reads whatever
  // is left, and returns; the drain happens once, afterwards, on the ordinary
  // path. Nothing calls `process.exit` — the timers are unref'd, so the
  // process ends when the work does.
  let requestStop = (): void => {};
  const stopped = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => requestStop());
  }

  const outcome = await lines((line) => recorder.record(line), stopped);

  clearInterval(timer);
  const report = await recorder.close(outcome);
  announce(report);
  if (!recorder.drained()) {
    console.error(
      `adp-recorder: ${report.pending} event(s) still spooled at ${config.ADP_RECORDER_SPOOL} — ` +
        `run 'adp-recorder flush' to finish delivering them`,
    );
    process.exitCode = 1;
  }
}

async function commandTail(args: Args): Promise<void> {
  const file = args.flags.file;
  if (typeof file !== "string") usage();
  await runSession(args, async (onLine, stopped) => {
    const { stop, poll } = tailFile(file, onLine, { fromStart: args.flags["from-start"] === true });
    // Follows until interrupted: a transcript has no end-of-file that means
    // "the session is over", which is why `wrap` exists for the case where
    // something does know.
    await stopped;
    // One last read before letting go, so the lines written between the final
    // poll and the signal are recorded rather than left in the file.
    poll();
    stop();
    // **`tail` always suspends, and that is honesty rather than pessimism.**
    // Nothing here can know the session finished: the transcript may still be
    // written to after this process stops watching it, and someone pressing ^C
    // on a follower is saying they are done watching, not that the agent is
    // done working. `suspended` is the state that says exactly that, and it is
    // resumable — where `closed` would be a claim this command is not in a
    // position to make.
    return "suspended";
  });
}

async function commandWrap(args: Args): Promise<void> {
  if (args.rest.length === 0) usage();
  await runSession(args, async (onLine, stopped) => {
    const [command, ...rest] = args.rest;
    const child = spawn(command!, rest, { stdio: ["inherit", "pipe", "inherit"] });
    const reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      // Passed through as well as recorded: wrapping must not change what the
      // person watching sees, or nobody will wrap anything.
      process.stdout.write(`${line}\n`);
      onLine(line);
    });
    // Either the child finishes on its own, or a signal asks us to stop — in
    // which case the child has had that signal too, being in the same process
    // group, and closing is what we are waiting for either way.
    const exit = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null } | null>((resolve) =>
        child.on("close", (code, signal) => resolve({ code, signal })),
      ),
      stopped.then(() => null),
    ]);
    reader.close();
    // **`wrap` is the command that can tell, which is why it exists.** The
    // harness ran to completion and said it succeeded, or it did not — exit 0
    // closes the session, and a non-zero code, a signal, or our own
    // interruption before the child finished all suspend it. Those are
    // different facts about the work, and until now the schema could hold the
    // difference while nothing produced it.
    return exit?.code === 0 ? "closed" : "suspended";
  });
}

/**
 * Tell ADP how a session ended, when the recorder that knew could not.
 *
 * The three guards are each a way of getting this wrong:
 *
 *   - **no `endedAt`** — the recorder never got to the end. It may be running.
 *   - **`producerAlive`** — it *is* running, on this machine, right now.
 *     Ending its session would turn a live recording into a stream of 409s.
 *   - **already `terminated`** — said once is enough, and `flush` is expected
 *     to be run repeatedly.
 *
 * The outcome itself is never decided here. It was written into the sidecar
 * when the session opened (`suspended`) and upgraded only by a clean exit, so
 * by the time `flush` reads it the fact is already settled — which is the only
 * way a recorder that was killed outright can still report what happened to it.
 */
async function terminateIfOwed(
  client: TrajectoryClient,
  spoolDir: string,
  meta: SessionMeta,
): Promise<SessionMeta> {
  if (meta.sessionId === null || meta.terminated || !meta.endedAt) return meta;
  if (producerAlive(meta)) return meta;

  const outcome: Outcome = meta.outcome ?? "suspended";
  const ended = await client.endSession(meta.owner, meta.repo, meta.sessionId, outcome);
  if (!ended.ok) {
    console.error(`adp-recorder: ${meta.sessionId}: could not mark ${outcome} — ${ended.message}`);
    return meta;
  }
  console.error(`adp-recorder: ${meta.owner}/${meta.repo} ${meta.sessionId}: marked ${outcome}`);
  const updated = { ...meta, terminated: true };
  writeSessionMeta(spoolDir, updated);
  return updated;
}

/**
 * Finish what a dead recorder started.
 *
 * Walks every spool in the directory and delivers what is undelivered. A
 * session with no server id was started while ADP was unreachable and never
 * got one; it is created here, which is what makes a whole session recorded
 * against a down server recoverable rather than merely buffered.
 */
async function commandFlush(args: Args): Promise<void> {
  const config = loadConfig();
  const client = new TrajectoryClient(config.ADP_SERVER_URL, config.ADP_TOKEN);
  const only = typeof args.flags.repo === "string" ? splitRepo(args.flags.repo) : null;
  const sessions = listSessions(config.ADP_RECORDER_SPOOL);
  if (sessions.length === 0) {
    console.error(`adp-recorder: nothing spooled at ${config.ADP_RECORDER_SPOOL}`);
    return;
  }

  let failures = 0;
  for (let meta of sessions) {
    if (only && (meta.owner !== only.owner || meta.repo !== only.repo)) continue;
    const spool = new Spool({ dir: config.ADP_RECORDER_SPOOL, sessionId: meta.localId });
    if (spool.drained()) {
      // Drained, but possibly not *finished*: a recorder that died between
      // delivering its last batch and telling ADP how the session ended leaves
      // exactly this. Ending it is the other half of what `flush` is for.
      meta = await terminateIfOwed(client, config.ADP_RECORDER_SPOOL, meta);
      spool.close();
      continue;
    }

    if (meta.sessionId === null) {
      try {
        const session = await client.startSession(meta.owner, meta.repo, {
          harness: meta.harness,
          intent_id: meta.intentId,
          run_id: meta.runId,
        });
        meta = { ...meta, sessionId: session.id };
        writeSessionMeta(config.ADP_RECORDER_SPOOL, meta);
      } catch (err) {
        console.error(`adp-recorder: ${meta.localId}: cannot create a session — ${String(err)}`);
        failures += 1;
        spool.close();
        continue;
      }
    }

    const report = await new Shipper({
      client,
      spool,
      owner: meta.owner,
      repo: meta.repo,
      sessionId: meta.sessionId!,
      producerId: config.ADP_RECORDER_ID,
      batchSize: config.ADP_RECORDER_BATCH_SIZE,
    }).drain();
    console.error(`adp-recorder: ${meta.owner}/${meta.repo} ${meta.sessionId}: ${report.state}`);
    // Only once everything is delivered. A closed session refuses appends, so
    // ending one over an undrained spool would make the rest of the recording
    // permanently undeliverable — the tidying-up would destroy the tail.
    if (report.state === "idle") meta = await terminateIfOwed(client, config.ADP_RECORDER_SPOOL, meta);
    announce(report);
    if (report.state !== "idle") failures += 1;
    spool.close();
  }
  // Exit non-zero when something is still undelivered, so a wrapper script can
  // tell "nothing to do" from "I could not finish".
  if (failures > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "tail":
      return commandTail(args);
    case "wrap":
      return commandWrap(args);
    case "flush":
      return commandFlush(args);
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
