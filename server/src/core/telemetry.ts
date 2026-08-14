// API-traffic telemetry — a named M2 prerequisite (docs/pragmatic_mvp.md:
// "GraphQL coverage widened from measured real traffic... nothing measures
// traffic today"), not the coverage-widening itself. Deliberately a plain
// in-process counter map, not a metrics library: this instance is a single
// process with no multi-worker fan-in to reconcile, and the whole surface is
// a handful of families — pulling in a dependency for that would be the
// tail wagging the dog. Counts reset on restart, which is fine for a
// traffic-shape signal scraped periodically, not an audit trail (that's
// `operations`, not this).
//
// M4-11 adds the queue families below and, with them, METRIC_FAMILIES: the
// declared list is what `server/src/observability-coverage.test.ts` checks
// the Cloud Monitoring dashboard and alert policies (infra/dev/) against, in
// both directions. A dashboard tile pointing at a metric this server does
// not export renders an empty chart forever and looks exactly like a healthy
// one — the same "a skipped test must never look like a passing one" failure
// mode, moved one layer out.

export type MetricType = "counter" | "gauge";

export interface MetricFamily {
  name: string;
  type: MetricType;
  help: string;
}

export const METRIC_FAMILIES: readonly MetricFamily[] = [
  {
    name: "adp_http_requests_total",
    type: "counter",
    help: "Total HTTP requests by method, route, and status.",
  },
  {
    name: "adp_graphql_operations_total",
    type: "counter",
    help: "Total GraphQL root-field executions by operation type, field, and outcome.",
  },
  {
    name: "adp_gate_jobs",
    type: "gauge",
    help: "Gate jobs currently in each non-terminal queue state.",
  },
  {
    name: "adp_gate_job_oldest_queued_age_seconds",
    type: "gauge",
    help: "Age of the oldest gate job still waiting to be claimed, in seconds. Zero when the queue is empty.",
  },
  {
    name: "adp_gate_job_oldest_running_age_seconds",
    type: "gauge",
    help: "Age of the oldest gate job still running, in seconds. Zero when nothing is running. A wedged running job (#92) climbs here even though the queued-age gauge stays flat.",
  },
  {
    name: "adp_gate_job_completions_total",
    type: "counter",
    help: "Total gate jobs reported complete by a runner, by terminal status.",
  },
];

const httpCounts = new Map<string, number>();
const graphqlCounts = new Map<string, number>();
const gateJobCompletions = new Map<string, number>();

// Set wholesale by core/gate-job-metrics.ts's sampler rather than incremented
// at the call sites: queue depth is a property of the table, not of this
// process, and a job can leave `queued` without this process being the one
// that moved it (another API replica, a manual fix, a restart mid-claim).
// Null until the first sample, so a scrape taken before the sampler has run
// emits no sample at all rather than a confident zero.
let gateJobGauge: {
  byStatus: Map<string, number>;
  oldestQueuedAgeSeconds: number;
  oldestRunningAgeSeconds: number;
} | null = null;

// NUL, because it is the one byte that cannot appear in any of the label
// values these keys are assembled from (a Fastify route pattern, a GraphQL
// field name, a status code) — so splitting a key back apart can never be
// ambiguous. Spelled as an escape rather than as a literal NUL byte, which is
// what the file held until M4-11: git classifies a file containing one as
// binary and stops showing a diff for it at all, so every change to this file
// was unreviewable.
const SEP = "\u0000";

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function recordHttpRequest(method: string, route: string, status: number): void {
  bump(httpCounts, `${method}${SEP}${route}${SEP}${status}`);
}

// `fieldName` is a root Query/Mutation field (e.g. "repository",
// "mergePullRequest") — the actual traffic-distribution signal GraphQL
// coverage decisions need, since `gh` and most clients rarely set the
// optional `operationName`.
export function recordGraphqlOperation(operationType: string, fieldName: string, ok: boolean): void {
  bump(graphqlCounts, `${operationType}${SEP}${fieldName}${SEP}${ok ? "ok" : "error"}`);
}

// The terminal status a runner reported (gate_jobs.status: succeeded, failed,
// timed_out, error). Kept as one labelled family rather than a success/failure
// pair because the distinction that matters operationally is not pass/fail —
// a `failed` gate is a gate doing its job — but `error`, which means the
// runner could not run the gate at all (docs/observability.md).
export function recordGateJobCompletion(status: string): void {
  bump(gateJobCompletions, status);
}

export function setGateJobGauges(sample: {
  byStatus: Map<string, number>;
  oldestQueuedAgeSeconds: number;
  oldestRunningAgeSeconds: number;
}): void {
  gateJobGauge = sample;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function familyHeader(lines: string[], name: string): void {
  const family = METRIC_FAMILIES.find((f) => f.name === name);
  // Unreachable via any call site below — the lookup exists so the declared
  // list is the single source of the HELP text rather than a second copy of
  // it that can drift from what the dashboards were built against.
  if (!family) throw new Error(`metric family ${name} is rendered but not declared in METRIC_FAMILIES`);
  lines.push(`# HELP ${family.name} ${family.help}`);
  lines.push(`# TYPE ${family.name} ${family.type}`);
}

// Prometheus text exposition format (https://prometheus.io/docs/instrumenting/exposition_formats/) —
// the de facto standard for a `/metrics` endpoint, scrapeable without a
// bespoke client. Cloud Monitoring's Ops Agent scrapes exactly this
// (infra/dev/startup.sh) and republishes each family as
// `prometheus.googleapis.com/<name>/<counter|gauge>`.
//
// Every declared family emits its HELP/TYPE header even with no samples, so a
// dashboard or alert can be built against a family before the first event of
// that kind has ever happened.
export function renderMetrics(): string {
  const lines: string[] = [];

  familyHeader(lines, "adp_http_requests_total");
  for (const [key, count] of httpCounts) {
    const [method, route, status] = key.split(SEP);
    lines.push(
      `adp_http_requests_total{method="${escapeLabel(method!)}",route="${escapeLabel(route!)}",status="${status}"} ${count}`,
    );
  }

  familyHeader(lines, "adp_graphql_operations_total");
  for (const [key, count] of graphqlCounts) {
    const [operationType, fieldName, outcome] = key.split(SEP);
    lines.push(
      `adp_graphql_operations_total{operation_type="${escapeLabel(operationType!)}",field="${escapeLabel(fieldName!)}",outcome="${outcome}"} ${count}`,
    );
  }

  familyHeader(lines, "adp_gate_jobs");
  if (gateJobGauge) {
    for (const [status, count] of gateJobGauge.byStatus) {
      lines.push(`adp_gate_jobs{status="${escapeLabel(status)}"} ${count}`);
    }
  }

  familyHeader(lines, "adp_gate_job_oldest_queued_age_seconds");
  if (gateJobGauge) {
    lines.push(`adp_gate_job_oldest_queued_age_seconds ${gateJobGauge.oldestQueuedAgeSeconds}`);
  }

  familyHeader(lines, "adp_gate_job_oldest_running_age_seconds");
  if (gateJobGauge) {
    lines.push(`adp_gate_job_oldest_running_age_seconds ${gateJobGauge.oldestRunningAgeSeconds}`);
  }

  familyHeader(lines, "adp_gate_job_completions_total");
  for (const [status, count] of gateJobCompletions) {
    lines.push(`adp_gate_job_completions_total{status="${escapeLabel(status)}"} ${count}`);
  }

  return lines.join("\n") + "\n";
}

// Test-only: counters are module-level singletons (one process, no
// multi-tenancy concern), so suites that assert on exact counts need a way
// back to zero between runs.
export function resetMetricsForTest(): void {
  httpCounts.clear();
  graphqlCounts.clear();
  gateJobCompletions.clear();
  gateJobGauge = null;
}
