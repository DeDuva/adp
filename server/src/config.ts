import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  GIT_ROOT: z.string().min(1),
  SIGNING_KEY: z.string().min(1),
  // #102: retired signing keys' PUBLIC halves, comma-separated hex, so
  // evidence signed before a key rotation keeps verifying after it (the
  // KeyRegistry core/signing.ts builds from this). Public keys only — the
  // rotated-out private key should not survive anywhere, this env var
  // included.
  RETIRED_SIGNING_PUBLIC_KEYS: z.string().optional(),
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
  // #92: how often expired gate-job leases are reaped
  // (core/gate-job-reaper.ts). Half a minute bounds how long a dead
  // runner's job stays wedged past its lease — fast enough that a requeue
  // beats any human noticing, coarse enough to cost nothing.
  GATE_JOB_REAPER_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),

  // M4-5: OIDC login. Every field is optional and the routes only mount when
  // both client credentials are present, because an instance that has not
  // configured an IdP must keep working exactly as before — token auth is the
  // MVP's identity story and OIDC is additive to it, not a replacement.
  //
  // Decision 1 (ROADMAP, resolved 2026-08-13) named Google, and these default
  // to Google's endpoints. They are still parameters rather than constants:
  // the verification in core/oidc.ts is issuer-generic, and hard-coding an
  // issuer would make the one thing worth testing against a second provider
  // untestable.
  OIDC_ISSUER: z.string().default("https://accounts.google.com"),
  OIDC_DISCOVERY_URL: z
    .string()
    .url()
    .default("https://accounts.google.com/.well-known/openid-configuration"),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  // Which email domains may create an identity by logging in. **Empty by
  // default, and empty means no auto-provisioning at all** — a login by
  // someone with no existing link is refused rather than welcomed. This is
  // the single most consequential line in the OIDC feature: the alternative
  // default, "any Google account may log in", turns a public deployment into
  // an open door, and it would do so silently. Pre-linking an identity stays
  // possible regardless of this setting.
  OIDC_ALLOWED_DOMAINS: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)),
  // How long a token minted by a login lasts. Bounded on purpose: a login
  // credential that never expires is a PAT with a worse provenance story.
  OIDC_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(720),
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
