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
  // Instance-level land-policy floor:
  // admin-owned, non-bypassable by any repo's adp.yaml — repos can only add
  // requirements on top, never remove one of these. Comma-separated
  // "gates_green" and/or "one_approval"; empty string means no floor.
  //
  // The default deliberately omits `one_approval` (#174). Since #121 that
  // requirement is author-independent, and a floor is a *floor*: because
  // resolveLandRequirements unions the three levels, nothing below the
  // instance can drop one. Shipping it on by default therefore hands a
  // developer evaluating ADP alone a refusal they structurally cannot
  // satisfy — they are the only principal, and the requirement exists to
  // constrain the person trying to satisfy it. GitHub's own default for a
  // fresh repository is zero required approvals, so this was stricter than
  // the incumbent for exactly the audience least able to absorb it.
  //
  // `gates_green` stays, and it is the one that carries the argument: a
  // merge is still refused while the change has no gate result, which is
  // the beat `make demo` is built on. `one_approval` becomes opt-in — one
  // env var, one line of adp.yaml, or one line of an org floor — which is
  // the right shape, since the deployments that want it are the ones that
  // have a second principal.
  LAND_POLICY_FLOOR: z
    .string()
    .default("gates_green")
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
  // M4-3: how often every org's storage is re-measured
  // (core/storage-usage.ts). Ten minutes, the longest interval of the four,
  // because this is the only one of them that full-scans an org's rows in
  // ten tables — and because the number it produces is a ceiling check, not
  // a control loop: this interval is exactly the overshoot an org can
  // achieve past its quota, and ten minutes of writes is a rounding error
  // against a ceiling measured in gigabytes. Lower it on an instance where
  // it is not.
  STORAGE_METER_INTERVAL_MS: z.coerce.number().int().positive().default(600_000),

  // #161: how long trajectory payloads are kept, in days, for an org that has
  // set no window of its own. **This is the interim answer, not the policy** —
  // PLAN.md 3-6 is that, and waits on bench arm 4's numbers. What this decides
  // is what happens in the meantime, and the meantime is not empty: ambient
  // capture writes at a volume nobody has operated before, against a promise of
  // unbounded retention that was never going to be kept.
  //
  // Zero keeps payloads forever, explicitly, and an operator who wants that
  // should say so rather than inherit it. Reducing a payload never touches the
  // chain: the event keeps its links, its hash and every typed column, and
  // verification reports how much of a range it could only take as recorded
  // rather than re-derive (core/trajectory-retention.ts).
  //
  // **Upgrading an existing instance changes behaviour**, which is the cost of
  // shipping a default instead of an implicit forever. Ninety days is
  // deliberately generous for that reason, and under #199's default
  // `trajectory.payloads: structure` a reduced event loses a shape whose
  // strings were already replaced by their byte counts.
  TRAJECTORY_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(90),
  // Once an hour. The window is measured in days, so a sweep this coarse
  // bounds overshoot to a rounding error against it — and this scans the
  // largest table in the schema, which is not something to do on a short timer.
  TRAJECTORY_RETENTION_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),

  // M4-5: OIDC login. Every field is optional and the routes only mount when
  // both client credentials are present, because an instance that has not
  // configured an IdP must keep working exactly as before — token auth is the
  // MVP's identity story and OIDC is additive to it, not a replacement.
  //
  // The identity-provider decision (resolved 2026-08-13) named Google, and these default
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
