import { execFileSync } from "node:child_process";

// What commit is this process actually running? On the dev box that question is
// otherwise unanswerable without an IAP SSH session: infra/dev/startup.sh
// redeploys from `main` on every scheduled boot, silently.
//
// Deliberately not in config.ts. Everything there is part of the fail-fast boot
// contract — missing or malformed means exit 1. Build provenance is the
// opposite: always optional, never worth refusing to boot over, and it has a
// local fallback that config.ts has no business knowing about.
export interface BuildInfo {
  /** Commit SHA this process is running, or "unknown" if it could not be determined. */
  sha: string;
  /** Branch or tag the deploy tracked. */
  ref: string;
  /** When the deploy captured that SHA, ISO-8601, or null if unknown. */
  builtAt: string | null;
}

export interface VersionPayload extends BuildInfo {
  startedAt: string;
  uptimeSeconds: number;
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Read the build stamp deploy time left behind, falling back to the working
 * checkout.
 *
 * `ADP_GIT_SHA` / `ADP_GIT_REF` / `ADP_DEPLOYED_AT` are written into
 * `deploy/.env` by infra/dev/startup.sh, so a deployed container reports what
 * was deployed rather than whatever it can see now — the container has no git
 * checkout at all, and a host that has one may have moved on since.
 *
 * Call once at boot: the fallback shells out to git.
 */
export function resolveBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  return {
    sha: env.ADP_GIT_SHA?.trim() || git(["rev-parse", "HEAD"]) || "unknown",
    ref: env.ADP_GIT_REF?.trim() || git(["rev-parse", "--abbrev-ref", "HEAD"]) || "unknown",
    builtAt: env.ADP_DEPLOYED_AT?.trim() || git(["log", "-1", "--format=%cI"]) || null,
  };
}

export function versionPayload(build: BuildInfo, startedAt: Date, now: Date = new Date()): VersionPayload {
  return {
    ...build,
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000)),
  };
}

// Registered here rather than inline in main.ts only so the test can mount the
// real route instead of a copy of it.
export function registerVersionRoute(
  app: { get: (path: string, handler: () => Promise<VersionPayload>) => unknown },
  build: BuildInfo,
  startedAt: Date,
): void {
  app.get("/version", async () => versionPayload(build, startedAt));
}
