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
