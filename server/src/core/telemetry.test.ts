import { describe, it, expect, beforeEach } from "vitest";
import {
  METRIC_FAMILIES,
  recordHttpRequest,
  recordGraphqlOperation,
  recordGateJobCompletion,
  setGateJobGauges,
  renderMetrics,
  resetMetricsForTest,
} from "./telemetry.js";

describe("telemetry", () => {
  beforeEach(() => {
    resetMetricsForTest();
  });

  it("counts repeated HTTP requests to the same method/route/status as one incrementing series", () => {
    recordHttpRequest("GET", "/api/v3/repos/:owner/:repo/pulls", 200);
    recordHttpRequest("GET", "/api/v3/repos/:owner/:repo/pulls", 200);
    recordHttpRequest("GET", "/api/v3/repos/:owner/:repo/pulls", 404);

    const body = renderMetrics();
    expect(body).toContain(
      'adp_http_requests_total{method="GET",route="/api/v3/repos/:owner/:repo/pulls",status="200"} 2',
    );
    expect(body).toContain(
      'adp_http_requests_total{method="GET",route="/api/v3/repos/:owner/:repo/pulls",status="404"} 1',
    );
  });

  it("counts GraphQL root fields by operation type, field, and outcome", () => {
    recordGraphqlOperation("mutation", "mergePullRequest", true);
    recordGraphqlOperation("mutation", "mergePullRequest", false);
    recordGraphqlOperation("query", "repository", true);

    const body = renderMetrics();
    expect(body).toContain(
      'adp_graphql_operations_total{operation_type="mutation",field="mergePullRequest",outcome="ok"} 1',
    );
    expect(body).toContain(
      'adp_graphql_operations_total{operation_type="mutation",field="mergePullRequest",outcome="error"} 1',
    );
    expect(body).toContain('adp_graphql_operations_total{operation_type="query",field="repository",outcome="ok"} 1');
  });

  it("renders valid Prometheus text exposition format (HELP/TYPE per metric family)", () => {
    recordHttpRequest("POST", "/api/v3/repos/:owner", 201);
    const body = renderMetrics();
    expect(body).toMatch(/# HELP adp_http_requests_total/);
    expect(body).toMatch(/# TYPE adp_http_requests_total counter/);
    expect(body.endsWith("\n")).toBe(true);
  });

  it("starts empty after a reset", () => {
    recordHttpRequest("GET", "/healthz", 200);
    resetMetricsForTest();
    const body = renderMetrics();
    expect(body).not.toContain("adp_http_requests_total{");
  });

  // M4-11 — the queue families. Sampled (gauges) and counted (completions)
  // rather than both one or the other; see core/gate-job-metrics.ts for why.
  it("renders the gate-job queue gauges from the latest sample", () => {
    setGateJobGauges({
      byStatus: new Map([
        ["queued", 3],
        ["running", 1],
      ]),
      oldestQueuedAgeSeconds: 42,
      oldestRunningAgeSeconds: 17,
    });

    const body = renderMetrics();
    expect(body).toContain('adp_gate_jobs{status="queued"} 3');
    expect(body).toContain('adp_gate_jobs{status="running"} 1');
    expect(body).toContain("adp_gate_job_oldest_queued_age_seconds 42");
    expect(body).toContain("adp_gate_job_oldest_running_age_seconds 17");
  });

  it("replaces the previous gauge sample rather than accumulating it", () => {
    setGateJobGauges({ byStatus: new Map([["queued", 5]]), oldestQueuedAgeSeconds: 99, oldestRunningAgeSeconds: 7 });
    setGateJobGauges({ byStatus: new Map([["queued", 0]]), oldestQueuedAgeSeconds: 0, oldestRunningAgeSeconds: 0 });

    const body = renderMetrics();
    expect(body).toContain('adp_gate_jobs{status="queued"} 0');
    expect(body).not.toContain('adp_gate_jobs{status="queued"} 5');
    expect(body).toContain("adp_gate_job_oldest_queued_age_seconds 0");
    expect(body).toContain("adp_gate_job_oldest_running_age_seconds 0");
  });

  // A confident zero before the first sample would be a lie the alert on
  // oldest-queued-age would happily believe.
  it("emits no gauge sample at all until the sampler has run once", () => {
    const body = renderMetrics();
    expect(body).toContain("# TYPE adp_gate_jobs gauge");
    expect(body).not.toContain("adp_gate_jobs{");
    expect(body).not.toMatch(/^adp_gate_job_oldest_queued_age_seconds /m);
    expect(body).not.toMatch(/^adp_gate_job_oldest_running_age_seconds /m);
  });

  it("counts gate-job completions by terminal status", () => {
    recordGateJobCompletion("succeeded");
    recordGateJobCompletion("succeeded");
    recordGateJobCompletion("error");

    const body = renderMetrics();
    expect(body).toContain('adp_gate_job_completions_total{status="succeeded"} 2');
    expect(body).toContain('adp_gate_job_completions_total{status="error"} 1');
  });

  // The dashboards and alert policies in infra/dev/ are built against these
  // names (server/src/observability-coverage.test.ts checks that mapping);
  // a family that is declared but never rendered would leave a tile that can
  // only ever be empty.
  it("emits a HELP/TYPE header for every declared family, sampled or not", () => {
    const body = renderMetrics();
    for (const family of METRIC_FAMILIES) {
      expect(body).toContain(`# HELP ${family.name} ${family.help}`);
      expect(body).toContain(`# TYPE ${family.name} ${family.type}`);
    }
  });
});
