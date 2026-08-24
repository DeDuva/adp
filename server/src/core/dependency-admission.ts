// Dependency admission v0: a lockfile/manifest
// diff becomes gate input — registry existence, an age/cooldown window, and
// OSV + OpenSSF malicious-package lookups — with a typed verdict per
// package, not just a pass/fail blob.
//
// One integration point covers both vulnerability *and* malicious-package
// lookups: OpenSSF's Malicious Packages project publishes directly into
// OSV.dev in OSV format (ids prefixed `MAL-`), so the same `POST
// api.osv.dev/v1/query` call this module makes returns both — confirmed
// against the live API, not assumed (queried a real reported-malicious npm
// package, `sdxcode1@9.9.9` / MAL-2025-2155, and a real CVE-affected one,
// `lodash@4.17.15`, which returns GHSA- ids with no MAL- prefix).
//
// Registry existence/age is real for npm only in v0 (registry.npmjs.org);
// other ecosystems are honestly reported as unverified rather than silently
// admitted — see evaluateDependency's "unverified ecosystem" branch.
export interface DependencyInput {
  ecosystem: string;
  name: string;
  version: string;
}

export type DependencyDecision = "admit" | "quarantine" | "block";

export interface DependencyVerdict extends DependencyInput {
  verdict: DependencyDecision;
  reasons: string[];
}

export interface DependencyAdmissionResult {
  status: "success" | "failure" | "pending";
  summary: string;
  verdicts: DependencyVerdict[];
}

export interface DependencyAdmissionOptions {
  // Newly-published packages this recent quarantine rather than admit — a
  // brand-new version is exactly when a compromised-maintainer or
  // dependency-confusion publish is least likely to have been caught yet.
  cooldownDays?: number;
  fetchImpl?: typeof fetch;
}

const OSV_QUERY_URL = "https://api.osv.dev/v1/query";
const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const DEFAULT_COOLDOWN_DAYS = 3;

interface OsvVulnCheck {
  maliciousIds: string[];
  otherIds: string[];
}

async function checkOsv(pkg: DependencyInput, fetchImpl: typeof fetch): Promise<OsvVulnCheck> {
  const res = await fetchImpl(OSV_QUERY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: pkg.version, package: { name: pkg.name, ecosystem: pkg.ecosystem } }),
  });
  if (!res.ok) {
    throw new Error(`OSV query for ${pkg.ecosystem}/${pkg.name}@${pkg.version} failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { vulns?: { id: string }[] };
  const vulns = body.vulns ?? [];
  // OpenSSF's malicious-packages project reserves the MAL- id prefix
  // (openssf.org/blog/2026/05/20/detecting-malicious-packages-using-the-osv-api/)
  // — everything else in this response is an ordinary vulnerability advisory.
  const maliciousIds = vulns.filter((v) => v.id.startsWith("MAL-")).map((v) => v.id);
  const otherIds = vulns.filter((v) => !v.id.startsWith("MAL-")).map((v) => v.id);
  return { maliciousIds, otherIds };
}

interface NpmRegistryCheck {
  exists: boolean;
  withinCooldown: boolean;
  publishedAt: string | null;
}

async function checkNpmRegistry(pkg: DependencyInput, cooldownDays: number, fetchImpl: typeof fetch): Promise<NpmRegistryCheck> {
  const res = await fetchImpl(`${NPM_REGISTRY_URL}/${encodeURIComponent(pkg.name)}`);
  if (res.status === 404) {
    return { exists: false, withinCooldown: false, publishedAt: null };
  }
  if (!res.ok) {
    throw new Error(`npm registry lookup for ${pkg.name} failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { time?: Record<string, string> };
  const publishedAt = body.time?.[pkg.version];
  if (!publishedAt) {
    // The package exists, but not this exact version — same "can't verify
    // what this is" risk as the package not existing at all.
    return { exists: false, withinCooldown: false, publishedAt: null };
  }
  const ageMs = Date.now() - new Date(publishedAt).getTime();
  const withinCooldown = ageMs < cooldownDays * 24 * 60 * 60 * 1000;
  return { exists: true, withinCooldown, publishedAt };
}

export async function evaluateDependency(
  pkg: DependencyInput,
  options: DependencyAdmissionOptions = {},
): Promise<DependencyVerdict> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cooldownDays = options.cooldownDays ?? DEFAULT_COOLDOWN_DAYS;
  const reasons: string[] = [];

  const osv = await checkOsv(pkg, fetchImpl);
  if (osv.maliciousIds.length > 0) {
    // A confirmed malicious package is never auto-admitted, regardless of
    // registry/cooldown findings — there's nothing a registry-age check
    // could tell us that overrides "OpenSSF reported this as malware."
    return { ...pkg, verdict: "block", reasons: [`reported malicious: ${osv.maliciousIds.join(", ")}`] };
  }
  if (osv.otherIds.length > 0) {
    reasons.push(`known vulnerabilities: ${osv.otherIds.join(", ")}`);
  }

  if (pkg.ecosystem === "npm") {
    const registry = await checkNpmRegistry(pkg, cooldownDays, fetchImpl);
    if (!registry.exists) {
      reasons.push(`version ${pkg.version} not found in the npm registry`);
    } else if (registry.withinCooldown) {
      reasons.push(`published ${registry.publishedAt}, within the ${cooldownDays}-day cooldown window`);
    }
  } else {
    // Honest about v0's scope rather than silently trusting an ecosystem
    // this module never actually checked.
    reasons.push(`registry existence/age not verified for ecosystem '${pkg.ecosystem}' in v0`);
  }

  return { ...pkg, verdict: reasons.length > 0 ? "quarantine" : "admit", reasons };
}

function summarize(verdicts: DependencyVerdict[]): string {
  const blocked = verdicts.filter((v) => v.verdict === "block");
  const quarantined = verdicts.filter((v) => v.verdict === "quarantine");
  if (blocked.length === 0 && quarantined.length === 0) {
    return `dependency admission: ${verdicts.length} package(s) admitted`;
  }
  const parts: string[] = [];
  if (blocked.length > 0) parts.push(`${blocked.length} blocked (${blocked.map((v) => v.name).join(", ")})`);
  if (quarantined.length > 0) parts.push(`${quarantined.length} quarantined (${quarantined.map((v) => v.name).join(", ")})`);
  return `dependency admission: ${parts.join(", ")}`;
}

// The overall status maps onto gate_results.status (schema.ts), which is
// what land policy's gates_green actually reads (core/gate-results-lookup.ts):
// "pending" is not green, same as "failure" — a quarantined package blocks
// the merge exactly like a hard failure would, until a supervisor resolves
// it by re-reporting the gate (there is no auto-resolution path in v0).
export async function evaluateDependencies(
  packages: DependencyInput[],
  options: DependencyAdmissionOptions = {},
): Promise<DependencyAdmissionResult> {
  const verdicts = await Promise.all(packages.map((pkg) => evaluateDependency(pkg, options)));
  const status = verdicts.some((v) => v.verdict === "block")
    ? "failure"
    : verdicts.some((v) => v.verdict === "quarantine")
      ? "pending"
      : "success";
  return { status, summary: summarize(verdicts), verdicts };
}
