// osv-scanner's native JSON output (`osv-scanner scan -L <lockfile> --format
// json`), documented at https://google.github.io/osv-scanner/output/ — the
// second adapter implementation, deliberately *not* SARIF, to prove the
// gate-report contract (docs/pragmatic_mvp.md M2) generalizes to a scanner's
// own format rather than only the one every other tool happens to share.
//
// Shape: { results: [ { source: {path, type}, packages: [ { package:
// {name, version, ecosystem}, vulnerabilities: [{id, summary, ...}] } ] } ] }
export function parseOsvJson(jsonText) {
  const doc = JSON.parse(jsonText);
  const vulnIds = new Set();
  const affectedPackages = [];

  for (const result of doc.results ?? []) {
    for (const pkg of result.packages ?? []) {
      const vulns = pkg.vulnerabilities ?? [];
      if (vulns.length === 0) continue;
      affectedPackages.push(`${pkg.package?.name ?? "unknown"}@${pkg.package?.version ?? "?"}`);
      for (const v of vulns) {
        if (v.id) vulnIds.add(v.id);
      }
    }
  }

  const status = affectedPackages.length > 0 ? "failure" : "success";
  const summary =
    affectedPackages.length === 0
      ? "osv-scanner: no known vulnerabilities"
      : `osv-scanner: ${vulnIds.size} known vulnerabilit${vulnIds.size === 1 ? "y" : "ies"} across ${
          affectedPackages.length
        } package(s) — ${affectedPackages.slice(0, 5).join(", ")}${affectedPackages.length > 5 ? ", ..." : ""}`;

  return { status, summary, vulnerablePackageCount: affectedPackages.length, vulnerabilityCount: vulnIds.size };
}
