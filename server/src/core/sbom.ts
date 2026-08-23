import { randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";
import type { GitBackend } from "./git-backend.js";
import type { Signer } from "./signing.js";
import { gateResults } from "../db/schema.js";
import { signStatement, type InTotoStatement } from "./dsse.js";
import { recordOperation } from "./operations.js";

// CycloneDX 1.5 JSON (https://cyclonedx.org/docs/1.5/json/) — SBOM per land
// emitted as ordinary evidence alongside a
// change, not a bespoke format. v0 reads `package-lock.json` only (the same
// npm-only scope core/dependency-admission.ts settled on) — a repo with no
// npm lockfile at the merged sha gets a valid, empty-components SBOM rather
// than an error, which is the honest answer for "this repo has no
// npm dependencies", not a failure.
export interface CycloneDxComponent {
  type: "library";
  name: string;
  version: string;
  purl: string;
}

export interface CycloneDxSbom {
  bomFormat: "CycloneDX";
  specVersion: "1.5";
  serialNumber: string;
  version: 1;
  metadata: {
    timestamp: string;
    component: { type: "application"; name: string; version: string };
  };
  components: CycloneDxComponent[];
}

// npm lockfile v2/v3 shape: `packages` is a flat map keyed by install path
// (e.g. "node_modules/lodash", or nested "node_modules/foo/node_modules/bar"
// for a version conflict) — the package name is the path's last
// "node_modules/" segment, not the whole path.
// purl-spec (github.com/package-url/purl-spec): for a scoped npm package the
// "/" between the @scope namespace and the bare name is purl's own
// structural separator and must stay literal — only the "@" (as %40) and
// each segment's own contents get percent-encoded. Verified against the
// spec's own worked example (`pkg:npm/%40angular/animation@12.3.1`) rather
// than encoding the whole "@scope/name" string as one opaque blob, which
// would double-encode the separator and produce an invalid purl.
function toPurl(name: string, version: string): string {
  const scoped = /^(@[^/]+)\/(.+)$/.exec(name);
  if (scoped) {
    const [, scope, pkg] = scoped;
    return `pkg:npm/${encodeURIComponent(scope!)}/${encodeURIComponent(pkg!)}@${version}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${version}`;
}

export function componentsFromNpmLockfile(lockfileJson: string): CycloneDxComponent[] {
  const lockfile = JSON.parse(lockfileJson) as { packages?: Record<string, { version?: string }> };
  const seen = new Set<string>();
  const components: CycloneDxComponent[] = [];

  for (const [pkgPath, meta] of Object.entries(lockfile.packages ?? {})) {
    if (!pkgPath || !meta.version) continue; // "" is the root project itself, not a dependency
    const match = /node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(pkgPath);
    if (!match) continue;
    const name = match[1]!;
    const key = `${name}@${meta.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    components.push({ type: "library", name, version: meta.version, purl: toPurl(name, meta.version) });
  }

  return components.sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
}

export async function generateCycloneDxSbom(
  gitBackend: GitBackend,
  owner: string,
  name: string,
  sha: string,
): Promise<CycloneDxSbom> {
  const lockfileStat = await gitBackend.statPath(owner, name, sha, "package-lock.json");
  const components =
    lockfileStat?.type === "blob"
      ? componentsFromNpmLockfile((await gitBackend.readBlob(owner, name, lockfileStat.sha)).toString("utf8"))
      : [];

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: { type: "application", name: `${owner}/${name}`, version: sha },
    },
    components,
  };
}

// Records the SBOM as an ordinary gate_results row — the same
// receiving-and-attestation shape as http-rest/gates.ts, and the same
// evidence bundle (core/evidence.ts) a gate result already surfaces
// through, so a client that reads evidence for a commit gets the SBOM for
// free rather than needing a second endpoint. `predicateType:
// "https://cyclonedx.org/bom"` is the documented in-toto convention for a
// CycloneDX predicate (the same shape `cosign attest --type cyclonedx`
// produces), not an ADP-specific type.
//
// Called after a merge lands, not inside the merge's own transaction —
// SBOM generation is bookkeeping about a change that already happened, the
// same reasoning http-git/hooks.ts's post-receive auto-record uses for why
// its own failures are logged, not surfaced as a merge failure.
export async function recordSbomEvidence(
  db: Db,
  gitBackend: GitBackend,
  signer: Signer,
  publicUrl: string,
  repo: { id: string; owner: string; name: string },
  sha: string,
  reporterId: string,
): Promise<void> {
  const sbom = await generateCycloneDxSbom(gitBackend, repo.owner, repo.name, sha);

  const statement: InTotoStatement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `git+${publicUrl}/${repo.owner}/${repo.name}`, digest: { sha1: sha } }],
    predicateType: "https://cyclonedx.org/bom",
    predicate: sbom,
  };
  const envelope = signStatement(signer, statement);

  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(gateResults)
      .values({
        repoId: repo.id,
        gitSha: sha,
        name: "sbom",
        status: "success",
        summary: `${sbom.components.length} component(s)`,
        reporterId,
        envelope,
      })
      .returning();

    await recordOperation(tx, {
      repoId: repo.id,
      actorId: reporterId,
      verb: "sbom.generate",
      target: `${repo.owner}/${repo.name}@${sha}#sbom`,
      after: { id: row!.id, componentCount: sbom.components.length },
    });
  });
}
