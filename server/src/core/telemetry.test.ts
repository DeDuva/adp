import { describe, it, expect, beforeEach } from "vitest";
import { recordHttpRequest, recordGraphqlOperation, renderMetrics, resetMetricsForTest } from "./telemetry.js";

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
});
