import { hostname } from "node:os";
import { z } from "zod";

// This process's own security posture (docs/pragmatic_mvp.md §4.5/§4.7:
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
  // default ... CPU/memory/wall-clock caps" (pragmatic_mvp.md §4.7). Per-job
  // overrides are not exposed yet: every claimed job runs under the same
  // instance-wide ceiling until M4-9d scopes caps to an org's own quota.
  RUNNER_MEMORY: z.string().min(1).default("2g"),
  RUNNER_CPUS: z.string().min(1).default("2"),
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
