import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { METRIC_FAMILIES, renderMetrics } from "./core/telemetry.js";

// M4-11. The same argument as spec-coverage.test.ts, one layer out.
//
// A dashboard tile or an alert policy that names a metric this server does not
// export does not fail, warn, or look broken: it renders an empty chart, and an
// empty chart is exactly what a healthy quiet system also renders. An alert
// built on one never fires — which is indistinguishable, from the outside, from
// an alert on a system that is fine. That is `CLAUDE.md`'s "a skipped test must
// never look like a passing one", applied to the thing that is supposed to be
// watching production.
//
// So this test binds the two sides together and fails in both directions:
//
//   1. Every `adp_*` metric named in infra/dev/ must be one the server exports.
//   2. Every family the server exports must appear somewhere in infra/dev/ —
//      otherwise it is a signal nobody is looking at, which is the cheaper of
//      the two failures but still a claim in METRIC_FAMILIES that nothing
//      backs.
//
// It reads the real dashboard JSON and the real Terraform, not a copy: the
// files Terraform applies are the files under test.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const INFRA_SOURCES = ["infra/dev/dashboards/adp-overview.json", "infra/dev/monitoring.tf"];

// Cloud Monitoring renames every scraped family on the way in:
// `adp_gate_jobs` (a gauge) arrives as
// `prometheus.googleapis.com/adp_gate_jobs/gauge`. Matching on the wrapper
// rather than on a bare `adp_\w+` is deliberate — it catches a filter that
// names a real metric but claims the wrong type, which silently matches
// nothing at all.
const METRIC_REFERENCE = /prometheus\.googleapis\.com\/(adp_[a-z0-9_]+)\/(counter|gauge)/g;

interface Reference {
  name: string;
  type: string;
  source: string;
}

function collectReferences(): Reference[] {
  const refs: Reference[] = [];
  for (const source of INFRA_SOURCES) {
    const text = readFileSync(new URL(source, `file://${repoRoot}`), "utf8");
    for (const match of text.matchAll(METRIC_REFERENCE)) {
      refs.push({ name: match[1]!, type: match[2]!, source });
    }
  }
  return refs;
}

describe("M4-11: the dashboards and alerts point at metrics that exist", () => {
  const references = collectReferences();

  it("finds metric references in every infra source (the regex still matches the files)", () => {
    // Guards the guard: a rename or a reformat that stopped this test from
    // matching anything would otherwise make it pass vacuously forever.
    for (const source of INFRA_SOURCES) {
      expect(references.filter((r) => r.source === source).length).toBeGreaterThan(0);
    }
  });

  it("names only metric families the server exports", () => {
    const declared = new Map(METRIC_FAMILIES.map((f) => [f.name, f.type]));

    for (const ref of references) {
      expect(
        declared.has(ref.name),
        `${ref.source} references ${ref.name}, which is not in METRIC_FAMILIES (server/src/core/telemetry.ts)`,
      ).toBe(true);
      expect(
        ref.type,
        `${ref.source} references ${ref.name} as a ${ref.type}, but the server exports it as a ${declared.get(ref.name)}`,
      ).toBe(declared.get(ref.name));
    }
  });

  it("leaves no exported family unwatched", () => {
    const referenced = new Set(references.map((r) => r.name));

    for (const family of METRIC_FAMILIES) {
      expect(
        referenced.has(family.name),
        `${family.name} is exported but appears on no dashboard and in no alert — either chart it in ${INFRA_SOURCES[0]}, alert on it in ${INFRA_SOURCES[1]}, or stop exporting it`,
      ).toBe(true);
    }
  });

  it("exports every declared family in the scrape output itself", () => {
    // The link in the middle of the chain: METRIC_FAMILIES is what the two
    // tests above compare infra/ against, so it is only worth anything if
    // /metrics actually renders what it declares.
    const body = renderMetrics();
    for (const family of METRIC_FAMILIES) {
      expect(body).toContain(`# TYPE ${family.name} ${family.type}`);
    }
  });

  it("keeps the alert policies pointed at the notification channel", () => {
    // An alert policy with no notification_channels is a policy that fires
    // into a console nobody has open. Terraform will happily apply one.
    const tf = readFileSync(new URL("infra/dev/monitoring.tf", `file://${repoRoot}`), "utf8");
    const policies = tf.match(/resource "google_monitoring_alert_policy"/g) ?? [];
    const channels = tf.match(/notification_channels = \[/g) ?? [];

    expect(policies.length).toBeGreaterThan(0);
    expect(channels.length).toBe(policies.length);
  });
});
