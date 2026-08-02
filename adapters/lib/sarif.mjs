// SARIF 2.1.0 (https://docs.oasis-open.org/sarif/sarif/v2.1.0/) — the format
// wizcli's `--sarif-output-file` flag produces (Wiz's own docs, e.g.
// https://developer.harness.io/docs/security-testing-orchestration/sto-techref-category/wiz/repo-scans-with-wiz/),
// and one of osv-scanner's two output formats. A `result`'s effective level
// isn't always on the result itself — SARIF lets a rule set a
// `defaultConfiguration.level` that applies when the result omits `level` —
// so this resolves that lookup rather than assuming every tool always sets
// `level` explicitly.
const SEVERITY_RANK = { error: 3, warning: 2, note: 1, none: 0 };
const DEFAULT_LEVEL = "warning";

// Verified against real output, not assumed: osv-scanner's own `--format
// sarif` marks every genuine vulnerability finding as `level: "warning"`,
// never `"error"` (checked against a live scan of a lockfile with known
// CVEs — no `error`-level results appeared at all). An "only error fails"
// default would silently pass every real finding from a real, widely-used
// scanner. Configurable via `failLevel` for tools that *do* use `error`
// meaningfully and want a stricter default.
const DEFAULT_FAIL_LEVEL = "warning";

function ruleLevels(run) {
  const levels = new Map();
  for (const rule of run.tool?.driver?.rules ?? []) {
    if (rule.id && rule.defaultConfiguration?.level) {
      levels.set(rule.id, rule.defaultConfiguration.level);
    }
  }
  return levels;
}

function effectiveLevel(result, levelsByRuleId) {
  if (result.level) return result.level;
  if (result.ruleId && levelsByRuleId.has(result.ruleId)) return levelsByRuleId.get(result.ruleId);
  return DEFAULT_LEVEL;
}

// Returns { status, summary, counts } — status is "failure" iff at least one
// result's effective severity rank is >= `failLevel`'s rank (SARIF's own
// ordering: error > warning > note > none), not just "any result at all" —
// a scanner that only ever emits notes shouldn't block a land.
export function parseSarif(sarifText, { failLevel = DEFAULT_FAIL_LEVEL } = {}) {
  const doc = JSON.parse(sarifText);
  const counts = { error: 0, warning: 0, note: 0, none: 0 };
  const toolNames = new Set();
  const failThreshold = SEVERITY_RANK[failLevel] ?? SEVERITY_RANK[DEFAULT_FAIL_LEVEL];

  for (const run of doc.runs ?? []) {
    if (run.tool?.driver?.name) toolNames.add(run.tool.driver.name);
    const levelsByRuleId = ruleLevels(run);
    for (const result of run.results ?? []) {
      const level = effectiveLevel(result, levelsByRuleId);
      counts[level] = (counts[level] ?? 0) + 1;
    }
  }

  const total = counts.error + counts.warning + counts.note + counts.none;
  const failed = Object.entries(counts).some(([level, count]) => count > 0 && SEVERITY_RANK[level] >= failThreshold);
  const status = failed ? "failure" : "success";
  const tools = [...toolNames].join(", ") || "sarif";
  const summary =
    total === 0
      ? `${tools}: no findings`
      : `${tools}: ${counts.error} error(s), ${counts.warning} warning(s), ${counts.note} note(s)`;

  return { status, summary, counts };
}
