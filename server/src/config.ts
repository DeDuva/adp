import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  GIT_ROOT: z.string().min(1),
  SIGNING_KEY: z.string().min(1),
  PUBLIC_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  // Real repos push real-sized packs; Fastify's 1 MiB default 413s those.
  // Bounds the git smart-HTTP request body, not any other route.
  GIT_MAX_PACK_BYTES: z.coerce.number().int().positive().default(500 * 1024 * 1024),
  // Instance-level land-policy floor (docs/pragmatic_mvp.md §1.5 item 2):
  // admin-owned, non-bypassable by any repo's adp.yaml — repos can only add
  // requirements on top, never remove one of these. Comma-separated
  // "gates_green" and/or "one_approval"; empty string means no floor.
  LAND_POLICY_FLOOR: z
    .string()
    .default("gates_green,one_approval")
    .transform((s) => s.split(",").map((r) => r.trim()).filter(Boolean)),
  // At-rest AES-256-GCM key (core/mirror-crypto.ts) — same
  // deterministic-key-from-env shape as SIGNING_KEY. Originally just the
  // mirror credential (a GitHub PAT per mirror), now also covers both
  // webhook-signing secrets (webhooks.secretCiphertext,
  // mirrors.webhookSecretCiphertext) — kept as one env var rather than
  // introducing a second required secret for the same "no plaintext secret
  // at rest" bar.
  MIRROR_CREDENTIAL_KEY: z.string().min(1),
  MIRROR_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  // M4-3: how often the expired-workspace sweeper runs (core/workspace-sweeper.ts).
  // Minutes, not milliseconds, unlike the mirror poller — a workspace's own
  // TTL is stated in hours, so a sweep interval this coarse costs nothing.
  WORKSPACE_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  // M4-11: how often the gate-job queue gauges are re-sampled
  // (core/gate-job-metrics.ts). Shorter than either job above because this
  // one is a read the dashboards are looking at, not work — and it bounds
  // how stale `adp_gate_job_oldest_queued_age_seconds` can be when the alert
  // on it evaluates.
  GATE_JOB_METRICS_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
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
