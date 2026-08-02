// Hand-rolled rather than a dependency (commander, yargs, ...) — five
// commands, each with 2-4 flags, doesn't earn one; matches this repo's
// general taste for skipping a library where a few dozen lines cover it
// (server/src/core/telemetry.ts's counters over a metrics library, for the
// same reason).
export function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = "true";
    }
  }
  return flags;
}

export function splitRepo(ownerSlashRepo: string): { owner: string; repo: string } {
  const [owner, repo] = ownerSlashRepo.split("/");
  if (!owner || !repo) {
    throw new Error(`repo must be in the form <owner>/<repo>, got '${ownerSlashRepo}'`);
  }
  return { owner, repo };
}
