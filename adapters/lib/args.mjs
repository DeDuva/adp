// Same reasoning as cli/src/args.ts's hand-rolled parser: each adapter has
// 3-5 flags, not enough to earn a dependency. Duplicated rather than
// imported from cli/ on purpose — adapters/ ships standalone scripts a
// user's CI drops in and runs with plain `node`, with no reason to also
// pull in the unrelated `adp` CLI package as a dependency just for this.
export function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
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

export function splitRepo(ownerSlashRepo) {
  const [owner, repo] = (ownerSlashRepo ?? "").split("/");
  if (!owner || !repo) {
    throw new Error(`--repo must be in the form <owner>/<repo>, got '${ownerSlashRepo}'`);
  }
  return { owner, repo };
}
