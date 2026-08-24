import { hostname } from "node:os";
import { z } from "zod";

// This process's own security posture (
// "host separation is not optional once adp.yaml becomes executable") is what
// this schema enforces the absence of, not what it configures — there is no
// DATABASE_URL, no SIGNING_KEY. The runner is a pure HTTP client of ADP_SERVER_URL,
// authenticated with a token scoped to nothing but the "runner" auth scope
// (server/src/auth/plugin.ts), and it is meant to run on a host that never
// holds either credential.
const EnvSchema = z.object({
  ADP_SERVER_URL: z.string().url(),
  ADP_RUNNER_TOKEN: z.string().min(1),
  // Opaque, reported as gate_jobs.claimed_by — never branched on by the
  // server (server/src/http-rest/gate-jobs.ts). Defaults to something that
  // identifies this process without requiring an operator to set anything.
  RUNNER_ID: z.string().min(1).default(`${hostname()}-${process.pid}`),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  // docker run --memory / --cpus — the resource-cap half of "network-deny by
  // default ... CPU/memory/wall-clock caps". Per-job
  // overrides are not exposed yet: every claimed job runs under the same
  // instance-wide ceiling until M4-9d scopes caps to an org's own quota.
  RUNNER_MEMORY: z.string().min(1).default("2g"),
  RUNNER_CPUS: z.string().min(1).default("2"),
  // docker create --pids-limit (#100): a gate that fork-bombs takes down the
  // container, not the host's PID space.
  RUNNER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  // #100: which images a pushed adp.yaml may run on THIS host. The gate
  // image is repo-controlled — any repo:write principal can name an
  // arbitrary registry image and this process will pull and run it — so the
  // host operator gets the last word. Comma-separated entries; an entry is
  // an exact image reference (which is how a digest pin works:
  // `img@sha256:...`) or a prefix ending in `*`. Unset means every image is
  // allowed — the single-tenant dev default, stated rather than implied; a
  // multi-tenant deployment should set it.
  RUNNER_IMAGE_ALLOWLIST: z.string().optional(),
});

export type Config = z.infer<typeof EnvSchema>;

// Exported for pollOnce and its tests. Deny by default once a list exists:
// an unmatched image is the operator's answer, not a gap to fall through.
export function imageAllowed(image: string, allowlist: string | undefined): boolean {
  if (allowlist === undefined) return true;
  const entries = allowlist
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  return entries.some((entry) => (entry.endsWith("*") ? image.startsWith(entry.slice(0, -1)) : image === entry));
}

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
