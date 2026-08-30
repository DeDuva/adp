import { homedir, hostname } from "node:os";
import path from "node:path";
import { z } from "zod";

// What this process is allowed to be, expressed as what the schema does not
// contain: no DATABASE_URL, no SIGNING_KEY. The recorder is a pure HTTP client
// of ADP_SERVER_URL, on the same terms as `runner/` — and unlike the runner it
// does not even need a privileged scope. Appending a trajectory is `repo:write`
// (server/src/http-rest/sessions.ts), the same scope a developer's own token
// already carries, which is what lets the recorder run as the developer rather
// than as infrastructure.
const EnvSchema = z.object({
  ADP_SERVER_URL: z.string().url(),
  ADP_TOKEN: z.string().min(1),

  // Where undelivered events live. Under the user's home rather than /tmp
  // deliberately: on this project's own dev machines /tmp is a RAM-backed
  // tmpfs wiped between sessions, and a spool that evaporates with the
  // terminal is the failure this whole file exists to prevent.
  ADP_RECORDER_SPOOL: z.string().min(1).default(path.join(homedir(), ".adp", "recorder")),

  // Recorded on every event as `producer_id`. Opaque to the server, which
  // never branches on it; it is there so that "which recorder wrote this
  // chain" is answerable, since one session has exactly one writer.
  ADP_RECORDER_ID: z.string().min(1).default(`${hostname()}-${process.pid}`),

  ADP_RECORDER_BATCH_SIZE: z.coerce.number().int().positive().max(1000).default(200),
  ADP_RECORDER_FLUSH_INTERVAL_MS: z.coerce.number().int().positive().default(2000),

  // The undelivered ceiling, in bytes. Past it the spool refuses events and
  // the gap is recorded in the trajectory rather than papered over — see
  // Spool.append. Defaults to 64 MiB, which at the storage analysis's measured
  // 833 B/event is about 80,000 undelivered events.
  ADP_RECORDER_MAX_SPOOL_BYTES: z.coerce.number().int().positive().default(64 * 1024 * 1024),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:");
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}
