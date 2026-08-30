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
import { ClaudeCodeReader } from "./readers/claude-code.js";
import { Recorder } from "./recorder.js";
import { Spool } from "./spool.js";
import { Shipper } from "./shipper.js";
import { listSessions, newSessionMeta, writeSessionMeta } from "./session.js";
import { tailFile } from "./tail.js";

function usage(): never {
  console.error(`usage: adp-recorder <command>

  tail  --repo <owner/name> --file <transcript.jsonl> [--from-start]
        [--harness <name>] [--intent <uuid>] [--run <uuid>]

  wrap  --repo <owner/name> [--harness <name>] [--intent <uuid>] [--run <uuid>]
        -- <command> [args...]

  flush [--repo <owner/name>]

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
function announce(report: { state: string; delivered: number; pending: number; reason?: string }): void {
  const detail = report.reason ? ` — ${report.reason}` : "";
  console.error(`adp-recorder: ${report.state} (delivered ${report.delivered}, pending ${report.pending})${detail}`);
}

async function runSession(
  args: Args,
  lines: (onLine: (line: string) => void, stopped: Promise<void>) => Promise<void>,
): Promise<void> {
  const config = loadConfig();
  const { owner, repo } = splitRepo(args.flags.repo);
  const harness = typeof args.flags.harness === "string" ? args.flags.harness : "claude-code";

  const meta = newSessionMeta({
    dir: config.ADP_RECORDER_SPOOL,
    owner,
    repo,
    harness,
    intentId: typeof args.flags.intent === "string" ? args.flags.intent : undefined,
    runId: typeof args.flags.run === "string" ? args.flags.run : undefined,
  });

  const recorder = new Recorder(
    {
      client: new TrajectoryClient(config.ADP_SERVER_URL, config.ADP_TOKEN),
      spoolDir: config.ADP_RECORDER_SPOOL,
      meta,
      producerId: config.ADP_RECORDER_ID,
      batchSize: config.ADP_RECORDER_BATCH_SIZE,
      maxSpoolBytes: config.ADP_RECORDER_MAX_SPOOL_BYTES,
    },
    new ClaudeCodeReader(),
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

  await lines((line) => recorder.record(line), stopped);

  clearInterval(timer);
  const report = await recorder.close();
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
    await Promise.race([new Promise<void>((resolve) => child.on("close", resolve)), stopped]);
    reader.close();
  });
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
